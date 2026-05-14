// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title CasinoHandsLib
/// @author Overtime
/// @notice Pure, internal-only helpers shared by V2 casino card games. All functions are
/// `internal pure` so they inline into the consuming contract's bytecode at compile time —
/// no separate library deployment, no DELEGATECALL, no storage, no linker reference. The
/// OZ upgrades validator treats inlined library code as part of the consumer's bytecode
/// and does not flag it
/// @dev Card encoding used by every consumer of this library:
///   `card = suit * 13 + rank0_12`, where `suit ∈ [0, 3]` and `rank0_12 ∈ [0, 12]`.
///   Evaluator-internal rank is `rank0_12 + 2` so 2 = deuce, 14 = ace.
///
/// HiLo uses a different on-card layout (`card = rank * 4 + suit`) and intentionally does NOT
/// consume this library — leave HiLo's local `_rank` helper alone
library CasinoHandsLib {
    uint8 internal constant DECK_SIZE = 52;

    /// @dev Bits consumed per Fisher-Yates swap. 16 bits gives < 0.04% bias on any remaining
    /// deck size in [50, 80]. Caller MUST ensure `n × SHUFFLE_SHIFT_BITS ≤ 256` for a single
    /// VRF word (re-seed externally if more swaps are needed — see Keno's bespoke draw)
    uint8 internal constant SHUFFLE_SHIFT_BITS = 16;
    uint64 internal constant SHUFFLE_SHIFT_MASK = 0xFFFF;

    /// @dev Evaluator-internal rank values. 2 = deuce, 14 = ace
    uint8 internal constant RANK_TWO = 2;
    uint8 internal constant RANK_ACE = 14;

    // Hand classes — numeric value matters: higher beats lower regardless of kickers.
    // Same encoding as the consumer contracts
    uint8 internal constant CLASS_HIGH_CARD = 0;
    uint8 internal constant CLASS_PAIR = 1;
    uint8 internal constant CLASS_TWO_PAIR = 2;
    uint8 internal constant CLASS_THREE_OF_A_KIND = 3;
    uint8 internal constant CLASS_STRAIGHT = 4;
    uint8 internal constant CLASS_FLUSH = 5;
    uint8 internal constant CLASS_FULL_HOUSE = 6;
    uint8 internal constant CLASS_FOUR_OF_A_KIND = 7;
    uint8 internal constant CLASS_STRAIGHT_FLUSH = 8;
    uint8 internal constant CLASS_ROYAL_FLUSH = 9;

    /* ========== DECK / SHUFFLE ========== */

    /// @notice Build a `size`-element deck over [0, 52) skipping any card whose bit is set in
    /// `excludeMask`. Pass `excludeMask = 0` for the full 52-card deck. Loop short-circuits when
    /// `size` slots are filled. Caller MUST pass `size == 52 - popcount(excludeMask)`; mismatched
    /// inputs either silently truncate (size too small) or revert on out-of-bounds write (size
    /// too large) — both are caller bugs, not normal paths
    function initDeck(uint8 size, uint64 excludeMask) internal pure returns (uint8[] memory deck) {
        deck = new uint8[](size);
        uint8 j;
        for (uint8 c; c < DECK_SIZE; ++c) {
            if ((excludeMask & (uint64(1) << c)) != 0) continue;
            deck[j] = c;
            ++j;
            if (j == size) break;
        }
    }

    /// @notice Performs `n` Fisher-Yates swaps on `deck` driven by `word`. The first `n` slots
    /// of `deck` end up containing `n` unique elements drawn uniformly (with ≤ 16/65536 ≈ 0.024%
    /// per-swap bias). Caller MUST ensure `n × SHUFFLE_SHIFT_BITS ≤ 256` so the cursor doesn't
    /// run out of entropy mid-shuffle
    function partialFisherYates(uint8[] memory deck, uint8 n, uint256 word) internal pure {
        uint256 len = deck.length;
        uint256 cursor = word;
        for (uint8 i; i < n; ++i) {
            uint256 remaining = len - i;
            uint256 j = i + ((cursor & SHUFFLE_SHIFT_MASK) % remaining);
            cursor >>= SHUFFLE_SHIFT_BITS;
            uint8 tmp = deck[i];
            deck[i] = deck[j];
            deck[j] = tmp;
        }
    }

    /* ========== BIT / RANK HELPERS ========== */

    /// @notice Brian Kernighan popcount over any uint up to uint256. Callers may pass uint8 /
    /// uint64 / uint128 — Solidity widens implicitly. Returns uint8 because no current caller
    /// counts more than 128 set bits (Keno's drawn-mask popcount is the maximum case)
    function popcount(uint256 x) internal pure returns (uint8 c) {
        unchecked {
            while (x != 0) {
                x &= x - 1;
                ++c;
            }
        }
    }

    /// @notice 5-in-a-row straight detection on a 16-bit rank-presence mask. Returns the
    /// high-card rank of the straight, or 0 if none. Handles the wheel A-2-3-4-5 (returns 5)
    function findStraightTop(uint16 mask) internal pure returns (uint8) {
        for (uint8 step; step <= 8; ++step) {
            uint8 top = RANK_ACE - step;
            uint16 fiveMask = uint16(0x1F) << (top - 4);
            if ((mask & fiveMask) == fiveMask) {
                return top;
            }
        }
        // Wheel: A-2-3-4-5 → top = 5. Bits: A=14 (0x4000), 2..5 (0x3C)
        if ((mask & 0x4000) != 0 && (mask & 0x3C) == 0x3C) {
            return 5;
        }
        return 0;
    }

    /// @notice Returns the top `n` ranks present in `mask`, high to low. Output array length
    /// is exactly `n`; if fewer than `n` bits are set the trailing slots remain at 0
    function topNRanks(uint16 mask, uint8 n) internal pure returns (uint8[] memory out) {
        out = new uint8[](n);
        uint8 idx;
        for (uint8 step; step < 13; ++step) {
            uint8 r = RANK_ACE - step;
            if ((mask & (uint16(1) << r)) != 0) {
                out[idx] = r;
                ++idx;
                if (idx == n) return out;
            }
        }
    }

    /// @notice `topNRanks` with up to 3 ranks first cleared from the mask. Pass 0 for any unused
    /// exclusion slot (rank 0 is not a valid rank in this encoding)
    function topNRanksExcluding(
        uint16 mask,
        uint8 n,
        uint8 ex0,
        uint8 ex1,
        uint8 ex2
    ) internal pure returns (uint8[] memory) {
        uint16 cleared = mask;
        if (ex0 != 0) cleared &= ~(uint16(1) << ex0);
        if (ex1 != 0) cleared &= ~(uint16(1) << ex1);
        if (ex2 != 0) cleared &= ~(uint16(1) << ex2);
        return topNRanks(cleared, n);
    }

    /// @notice Packs a hand value into a single uint256:
    ///   `[class:4][r1:4][r2:4][r3:4][r4:4][r5:4]`. Higher numeric value = stronger hand
    function pack(uint8 class_, uint8 r1, uint8 r2, uint8 r3, uint8 r4, uint8 r5) internal pure returns (uint256) {
        return
            (uint256(class_) << 20) |
            (uint256(r1) << 16) |
            (uint256(r2) << 12) |
            (uint256(r3) << 8) |
            (uint256(r4) << 4) |
            uint256(r5);
    }

    /// @notice Copy a fixed-size 7-card array into a dynamic uint8[] suitable for passing to
    /// `evaluateCards7`. Consumers store hands as `uint8[7] memory` (cheap to build inline) but
    /// the evaluator takes `uint8[] memory` so a 5-card or 7-card variant can share the entry
    function toMemArray7(uint8[7] memory src) internal pure returns (uint8[] memory out) {
        out = new uint8[](7);
        for (uint8 i; i < 7; ++i) out[i] = src[i];
    }

    /* ========== 7-CARD BEST-OF-5 EVALUATOR ========== */

    /// @notice Evaluates a 5–7 card hand and returns the packed best-5 hand value
    /// (`pack(class, r1..r5)`). Encoding: `[class:4][r1:4][r2:4][r3:4][r4:4][r5:4]`.
    /// `class` = 0 (HC) .. 9 (Royal). Padded ranks default to 0. Output orders within the same
    /// class via tie-breaker ranks, so two values can be `<` / `==` / `>` compared directly
    function evaluateCards7(uint8[] memory cards) internal pure returns (uint256) {
        uint8[15] memory rankCount;
        uint16 rankMask;
        uint16[4] memory suitRankMask;
        uint8[4] memory suitCount;

        for (uint256 i; i < cards.length; ++i) {
            uint8 r = uint8(cards[i] % 13) + RANK_TWO;
            uint8 s = uint8(cards[i] / 13);
            ++rankCount[r];
            ++suitCount[s];
            rankMask |= uint16(1) << r;
            suitRankMask[s] |= uint16(1) << r;
        }

        int8 flushSuit = -1;
        for (uint8 s; s < 4; ++s) {
            if (suitCount[s] >= 5) {
                flushSuit = int8(s);
                break;
            }
        }

        if (flushSuit >= 0) {
            uint16 fmask = suitRankMask[uint8(flushSuit)];
            uint8 sfTop = findStraightTop(fmask);
            if (sfTop > 0) {
                if (sfTop == RANK_ACE) {
                    return pack(CLASS_ROYAL_FLUSH, RANK_ACE, 0, 0, 0, 0);
                }
                return pack(CLASS_STRAIGHT_FLUSH, sfTop, 0, 0, 0, 0);
            }
        }

        uint8 fourRank;
        uint8 firstThree;
        uint8 secondThree;
        uint8 firstPair;
        uint8 secondPair;
        for (uint8 step; step < 13; ++step) {
            uint8 r = RANK_ACE - step;
            if (rankCount[r] == 4) {
                if (fourRank == 0) fourRank = r;
            } else if (rankCount[r] == 3) {
                if (firstThree == 0) firstThree = r;
                else if (secondThree == 0) secondThree = r;
            } else if (rankCount[r] == 2) {
                if (firstPair == 0) firstPair = r;
                else if (secondPair == 0) secondPair = r;
            }
        }

        if (fourRank > 0) {
            uint8 kicker = topNRanksExcluding(rankMask, 1, fourRank, 0, 0)[0];
            return pack(CLASS_FOUR_OF_A_KIND, fourRank, kicker, 0, 0, 0);
        }

        if (firstThree > 0 && (secondThree > 0 || firstPair > 0)) {
            uint8 pairRank = secondThree > firstPair ? secondThree : firstPair;
            return pack(CLASS_FULL_HOUSE, firstThree, pairRank, 0, 0, 0);
        }

        if (flushSuit >= 0) {
            uint8[] memory top5 = topNRanks(suitRankMask[uint8(flushSuit)], 5);
            return pack(CLASS_FLUSH, top5[0], top5[1], top5[2], top5[3], top5[4]);
        }

        uint8 straightTop = findStraightTop(rankMask);
        if (straightTop > 0) {
            return pack(CLASS_STRAIGHT, straightTop, 0, 0, 0, 0);
        }

        if (firstThree > 0) {
            uint8[] memory kickers = topNRanksExcluding(rankMask, 2, firstThree, 0, 0);
            return pack(CLASS_THREE_OF_A_KIND, firstThree, kickers[0], kickers[1], 0, 0);
        }

        if (firstPair > 0 && secondPair > 0) {
            uint8[] memory kickers = topNRanksExcluding(rankMask, 1, firstPair, secondPair, 0);
            return pack(CLASS_TWO_PAIR, firstPair, secondPair, kickers[0], 0, 0);
        }

        if (firstPair > 0) {
            uint8[] memory kickers = topNRanksExcluding(rankMask, 3, firstPair, 0, 0);
            return pack(CLASS_PAIR, firstPair, kickers[0], kickers[1], kickers[2], 0);
        }

        uint8[] memory hc = topNRanks(rankMask, 5);
        return pack(CLASS_HIGH_CARD, hc[0], hc[1], hc[2], hc[3], hc[4]);
    }
}
