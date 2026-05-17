// ============================================================================
// OvertimeUltimateHoldem Cross-Validation — full multi-decision flow through
// MockVRFCoordinator. Per-bet asserts hole cards, community, dealer cards,
// outcome, and per-leg payouts (ante / play / blind) against off-chain model.
//
// Strategy: deterministic, must match on both sides:
//   pre-flop raise:  pocket pair OR both cards >= Q
//   post-flop raise: made pair-or-better using ≥1 hole card
//   river raise:     7-card eval class >= PAIR with pair using ≥1 hole card
//   else fold (river only — no folds earlier in UTH)
// ============================================================================

const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const { upgrades, ethers } = require('hardhat');

const WETH_KEY = ethers.encodeBytes32String('WETH');
const OVER_KEY = ethers.encodeBytes32String('OVER');
const WETH_PRICE = ethers.parseEther('3000');
const OVER_PRICE = ethers.parseEther('1');
const MAX_PROFIT_USD = ethers.parseEther('1000000');
const CANCEL_TIMEOUT = 3600n;
const USDC_UNIT = 1_000_000n;
const BET_AMOUNT = 3n * USDC_UNIT;

const N_BETS = Number(process.env.N_BETS || 1000);
const PROGRESS_EVERY = 100;

const DECK_SIZE = 52;
const MASK = 0xffffn;
const SHIFT = 16n;

const HandClass = {
	HIGH_CARD: 0,
	PAIR: 1,
	TWO_PAIR: 2,
	THREE_OF_A_KIND: 3,
	STRAIGHT: 4,
	FLUSH: 5,
	FULL_HOUSE: 6,
	FOUR_OF_A_KIND: 7,
	STRAIGHT_FLUSH: 8,
	ROYAL_FLUSH: 9,
};
const Outcome = {
	NONE: 0,
	FOLDED: 1,
	DEALER_NOT_QUALIFIED: 2,
	PLAYER_WIN: 3,
	DEALER_WIN: 4,
	TIE: 5,
};
const BLIND_MULT = {
	[HandClass.ROYAL_FLUSH]: 500,
	[HandClass.STRAIGHT_FLUSH]: 50,
	[HandClass.FOUR_OF_A_KIND]: 10,
	[HandClass.FULL_HOUSE]: 3,
	[HandClass.FLUSH]: 1,
	[HandClass.STRAIGHT]: 1,
};

function wordFromSeed(seed) {
	return BigInt('0x' + ethers.id(`uth-xval-${seed}`).slice(2));
}

function rankOf(c) {
	return (c % 13) + 2;
}
function suitOf(c) {
	return Math.floor(c / 13);
}

function partialFisherYates(deck, n, word) {
	const d = [...deck];
	let cursor = BigInt(word);
	for (let i = 0; i < n; i++) {
		const rem = BigInt(d.length - i);
		const j = i + Number((cursor & MASK) % rem);
		cursor >>= SHIFT;
		[d[i], d[j]] = [d[j], d[i]];
	}
	return d.slice(0, n);
}

const FULL_DECK = Array.from({ length: DECK_SIZE }, (_, i) => i);
function deckExcluding(excluded) {
	const s = new Set(excluded);
	return FULL_DECK.filter((c) => !s.has(c));
}

function findStraightTop(rankMask) {
	for (let top = 14; top >= 6; top--) {
		const fiveMask = (0x1f << (top - 4)) & 0xffff;
		if ((rankMask & fiveMask) === fiveMask) return top;
	}
	if ((rankMask & 0x4000) !== 0 && (rankMask & 0x3c) === 0x3c) return 5;
	return 0;
}

function topNRanks(mask, n) {
	const out = [];
	for (let r = 14; r >= 2 && out.length < n; r--) {
		if ((mask & (1 << r)) !== 0) out.push(r);
	}
	while (out.length < n) out.push(0);
	return out;
}
function topNRanksExcluding(mask, n, ex0 = 0, ex1 = 0, ex2 = 0) {
	let m = mask;
	if (ex0) m &= ~(1 << ex0);
	if (ex1) m &= ~(1 << ex1);
	if (ex2) m &= ~(1 << ex2);
	return topNRanks(m, n);
}
function packHand(class_, r1 = 0, r2 = 0, r3 = 0, r4 = 0, r5 = 0) {
	return (class_ << 20) | (r1 << 16) | (r2 << 12) | (r3 << 8) | (r4 << 4) | r5;
}

function evaluateCards(cards) {
	const rankCount = new Array(15).fill(0);
	const suitCount = [0, 0, 0, 0];
	let rankMask = 0;
	const suitRankMask = [0, 0, 0, 0];
	for (const c of cards) {
		const r = rankOf(c);
		const s = suitOf(c);
		rankCount[r]++;
		suitCount[s]++;
		rankMask |= 1 << r;
		suitRankMask[s] |= 1 << r;
	}
	let flushSuit = -1;
	for (let s = 0; s < 4; s++)
		if (suitCount[s] >= 5) {
			flushSuit = s;
			break;
		}
	if (flushSuit >= 0) {
		const sfTop = findStraightTop(suitRankMask[flushSuit]);
		if (sfTop > 0) {
			if (sfTop === 14) return packHand(HandClass.ROYAL_FLUSH, 14);
			return packHand(HandClass.STRAIGHT_FLUSH, sfTop);
		}
	}
	let fourRank = 0,
		firstThree = 0,
		secondThree = 0,
		firstPair = 0,
		secondPair = 0;
	for (let r = 14; r >= 2; r--) {
		if (rankCount[r] === 4 && !fourRank) fourRank = r;
		else if (rankCount[r] === 3) {
			if (!firstThree) firstThree = r;
			else if (!secondThree) secondThree = r;
		} else if (rankCount[r] === 2) {
			if (!firstPair) firstPair = r;
			else if (!secondPair) secondPair = r;
		}
	}
	if (fourRank) {
		const k = topNRanksExcluding(rankMask, 1, fourRank)[0];
		return packHand(HandClass.FOUR_OF_A_KIND, fourRank, k);
	}
	if (firstThree > 0 && (secondThree > 0 || firstPair > 0)) {
		const pairRank = secondThree > firstPair ? secondThree : firstPair;
		return packHand(HandClass.FULL_HOUSE, firstThree, pairRank);
	}
	if (flushSuit >= 0) {
		const t5 = topNRanks(suitRankMask[flushSuit], 5);
		return packHand(HandClass.FLUSH, t5[0], t5[1], t5[2], t5[3], t5[4]);
	}
	const straightTop = findStraightTop(rankMask);
	if (straightTop > 0) return packHand(HandClass.STRAIGHT, straightTop);
	if (firstThree > 0) {
		const ks = topNRanksExcluding(rankMask, 2, firstThree);
		return packHand(HandClass.THREE_OF_A_KIND, firstThree, ks[0], ks[1]);
	}
	if (firstPair > 0 && secondPair > 0) {
		const ks = topNRanksExcluding(rankMask, 1, firstPair, secondPair);
		return packHand(HandClass.TWO_PAIR, firstPair, secondPair, ks[0]);
	}
	if (firstPair > 0) {
		const ks = topNRanksExcluding(rankMask, 3, firstPair);
		return packHand(HandClass.PAIR, firstPair, ks[0], ks[1], ks[2]);
	}
	const hc = topNRanks(rankMask, 5);
	return packHand(HandClass.HIGH_CARD, hc[0], hc[1], hc[2], hc[3], hc[4]);
}

function unpackClass(h) {
	return (h >> 20) & 0xf;
}
function dealerQualifies(h) {
	return unpackClass(h) >= HandClass.PAIR;
}

// Strategy decisions — must be deterministic
function decisionPreFlop(hole) {
	const r0 = rankOf(hole[0]);
	const r1 = rankOf(hole[1]);
	if (r0 === r1) return true; // pocket pair
	if (r0 >= 12 && r1 >= 12) return true; // both >= Q
	return false;
}

function decisionPostFlop(hole, flop) {
	const cards = [hole[0], hole[1], flop[0], flop[1], flop[2]];
	const ev = evaluateCards(cards);
	const cls = unpackClass(ev);
	if (cls >= HandClass.TWO_PAIR) return true;
	if (cls === HandClass.PAIR) {
		// Use a hole card? — pair rank is in `ev` bits 16-19
		const pairRank = (ev >> 16) & 0xf;
		if (rankOf(hole[0]) === pairRank || rankOf(hole[1]) === pairRank) return true;
		return false;
	}
	return false;
}

function decisionRiver(hole, community) {
	const seven = [hole[0], hole[1], ...community];
	const ev = evaluateCards(seven);
	const cls = unpackClass(ev);
	if (cls >= HandClass.TWO_PAIR) return true;
	if (cls === HandClass.PAIR) {
		const pairRank = (ev >> 16) & 0xf;
		if (rankOf(hole[0]) === pairRank || rankOf(hole[1]) === pairRank) return true;
		return false;
	}
	return false;
}

function parseEvent(iface, receipt, name) {
	for (const l of receipt.logs) {
		try {
			const p = iface.parseLog(l);
			if (p?.name === name) return p;
		} catch {}
	}
	return null;
}

async function deployFixture() {
	const [owner, riskManager, resolver, pauser, player, daoSink] = await ethers.getSigners();
	const ExoticUSDC = await ethers.getContractFactory('ExoticUSDC');
	const usdc = await ExoticUSDC.deploy();
	const usdcAddr = await usdc.getAddress();
	const ExoticUSD = await ethers.getContractFactory('ExoticUSD');
	const weth = await ExoticUSD.deploy();
	const over = await ExoticUSD.deploy();
	const FBH = await ethers.getContractFactory('MockFreeBetsHolder');
	const fbh = await FBH.deploy(daoSink.address);
	const PriceFeed = await ethers.getContractFactory('MockPriceFeed');
	const priceFeed = await PriceFeed.deploy();
	await priceFeed.setPriceFeedForCollateral(WETH_KEY, await weth.getAddress(), WETH_PRICE);
	await priceFeed.setPriceFeedForCollateral(OVER_KEY, await over.getAddress(), OVER_PRICE);
	const Manager = await ethers.getContractFactory('SportsAMMV2Manager');
	const manager = await upgrades.deployProxy(Manager, [owner.address]);
	const managerAddr = await manager.getAddress();
	await manager.setWhitelistedAddresses([riskManager.address], 1, true);
	await manager.setWhitelistedAddresses([resolver.address], 2, true);
	await manager.setWhitelistedAddresses([pauser.address], 3, true);
	const VRF = await ethers.getContractFactory('MockVRFCoordinator');
	const vrf = await VRF.deploy();
	const Core = await ethers.getContractFactory('CasinoCoreV2');
	const core = await upgrades.deployProxy(Core, [], { initializer: false });
	const coreAddr = await core.getAddress();
	await core.initialize(
		{
			owner: owner.address,
			manager: managerAddr,
			priceFeed: await priceFeed.getAddress(),
			vrfCoordinator: await vrf.getAddress(),
			freeBetsHolder: await fbh.getAddress(),
			referrals: ethers.ZeroAddress,
		},
		{
			usdc: usdcAddr,
			weth: await weth.getAddress(),
			over: await over.getAddress(),
			wethPriceFeedKey: WETH_KEY,
			overPriceFeedKey: OVER_KEY,
		},
		MAX_PROFIT_USD,
		CANCEL_TIMEOUT,
		{
			subscriptionId: 1,
			keyHash: ethers.ZeroHash,
			callbackGasLimit: 500000,
			requestConfirmations: 3,
			nativePayment: false,
		}
	);
	const UTH = await ethers.getContractFactory('OvertimeUltimateHoldem');
	const uth = await upgrades.deployProxy(UTH, [], { initializer: false });
	const uthAddr = await uth.getAddress();
	await uth.initialize(owner.address, coreAddr, managerAddr);
	await core.registerGame(uthAddr);
	await core.setMaxNetLossPerGameUsd(uthAddr, ethers.parseEther('5000000'));
	await usdc.setDefaultAmount(1_000_000n * USDC_UNIT);
	await usdc.mintForUser(owner.address);
	await usdc.transfer(coreAddr, 200_000n * USDC_UNIT);
	await usdc.transfer(player.address, 100_000n * USDC_UNIT);
	await usdc.connect(player).approve(coreAddr, ethers.MaxUint256);
	return { uth, uthAddr, vrf, core, coreAddr, usdc, usdcAddr, player };
}

// Expected payouts at resolve, given final 7-card hands + playAmount
function computeResolution(playerSeven, dealerSeven, ante, playAmount) {
	const pVal = evaluateCards(playerSeven);
	const dVal = evaluateCards(dealerSeven);
	const dq = dealerQualifies(dVal);
	const blindOnWin = (() => {
		const m = BLIND_MULT[unpackClass(pVal)] || 0;
		return m === 0 ? ante : ante * BigInt(1 + m);
	})();
	const blindOnPush = ante;
	let antePayout = 0n,
		playPayout = 0n,
		blindPayout = 0n,
		outcome;
	if (!dq) {
		outcome = Outcome.DEALER_NOT_QUALIFIED;
		antePayout = ante;
		if (pVal > dVal) {
			playPayout = playAmount * 2n;
			blindPayout = blindOnWin;
		} else if (pVal === dVal) {
			playPayout = playAmount;
			blindPayout = blindOnPush;
		}
	} else if (pVal > dVal) {
		outcome = Outcome.PLAYER_WIN;
		antePayout = ante * 2n;
		playPayout = playAmount * 2n;
		blindPayout = blindOnWin;
	} else if (pVal < dVal) {
		outcome = Outcome.DEALER_WIN;
	} else {
		outcome = Outcome.TIE;
		antePayout = ante;
		playPayout = playAmount;
		blindPayout = blindOnPush;
	}
	return { outcome, antePayout, playPayout, blindPayout };
}

describe('UTH Cross-Validation: real on-chain', () => {
	it(`places ${N_BETS.toLocaleString(
		'en-US'
	)} bets and per-bet asserts contract == off-chain model`, async function () {
		this.timeout(60 * 60 * 1000);

		const ctx = await loadFixture(deployFixture);
		const { uth, vrf, core, coreAddr, usdcAddr, player } = ctx;

		let stake = 0n;
		let payout = 0n;
		const outcomes = { folded: 0, dnq: 0, win: 0, loss: 0, tie: 0 };
		const startTime = Date.now();

		for (let i = 0; i < N_BETS; i++) {
			const ante = BET_AMOUNT;

			const word1 = wordFromSeed(`b${i}-w1`);
			const word2 = wordFromSeed(`b${i}-w2`);
			const word3 = wordFromSeed(`b${i}-w3`);
			const word4 = wordFromSeed(`b${i}-w4`);

			// Off-chain: VRF1 → hole
			const hole = partialFisherYates(FULL_DECK, 2, word1);

			// Place
			const tx = await uth.connect(player).placeBet(usdcAddr, ante, ethers.ZeroAddress, false);
			const r1 = await tx.wait();
			const placed = parseEvent(uth.interface, r1, 'BetPlaced');
			const betId = placed.args.betId;
			const reqId1 = placed.args.requestId;
			await vrf.fulfillRandomWords(coreAddr, reqId1, [word1]);

			stake += ante * 2n; // ante + blind

			// Verify hole
			let full = await uth.getFullRecord(betId);
			for (let k = 0; k < 2; k++) {
				expect(Number(full.playerHole[k]), `hole[${k}] bet ${i}`).to.equal(hole[k]);
			}

			// Decide pre-flop
			let playAmount = 0n;
			let playerSeven, dealerSeven;

			if (decisionPreFlop(hole)) {
				// Raise 3× — VRF2 deals all 7 (5 community + 2 dealer)
				playAmount = 3n * ante;
				const remaining = partialFisherYates(deckExcluding(hole), 7, word2);
				const community = remaining.slice(0, 5);
				const dealerHole = remaining.slice(5, 7);
				playerSeven = [...hole, ...community];
				dealerSeven = [...dealerHole, ...community];

				await (await uth.connect(player).makeAction(betId, 0)).wait();
				const reqId2r = await vrf.lastRequestId();
				await vrf.fulfillRandomWords(coreAddr, reqId2r, [word2]);
			} else {
				// Check pre-flop → VRF2 deals flop only
				const flop = partialFisherYates(deckExcluding(hole), 3, word2);

				const tx2 = await uth.connect(player).makeAction(betId, 1);
				const r2 = await tx2.wait();
				const checked = parseEvent(uth.interface, r2, 'CheckedPreFlop');
				const reqId2 = checked.args.requestId;
				await vrf.fulfillRandomWords(coreAddr, reqId2, [word2]);

				full = await uth.getFullRecord(betId);
				for (let k = 0; k < 3; k++) {
					expect(Number(full.community[k]), `flop[${k}] bet ${i}`).to.equal(flop[k]);
				}

				if (decisionPostFlop(hole, flop)) {
					playAmount = 2n * ante;
					const rem = partialFisherYates(deckExcluding([...hole, ...flop]), 4, word3);
					const turn = rem[0],
						river = rem[1];
					const dealerHole = [rem[2], rem[3]];
					const community = [...flop, turn, river];
					playerSeven = [...hole, ...community];
					dealerSeven = [...dealerHole, ...community];

					await (await uth.connect(player).makeAction(betId, 2)).wait();
					const reqId3r = await vrf.lastRequestId();
					await vrf.fulfillRandomWords(coreAddr, reqId3r, [word3]);
				} else {
					// Check post-flop → VRF3 deals turn + river
					const tr = partialFisherYates(deckExcluding([...hole, ...flop]), 2, word3);
					const tx3 = await uth.connect(player).makeAction(betId, 3);
					const r3 = await tx3.wait();
					const checked3 = parseEvent(uth.interface, r3, 'CheckedPostFlop');
					const reqId3 = checked3.args.requestId;
					await vrf.fulfillRandomWords(coreAddr, reqId3, [word3]);

					full = await uth.getFullRecord(betId);
					expect(Number(full.community[3]), `turn bet ${i}`).to.equal(tr[0]);
					expect(Number(full.community[4]), `river bet ${i}`).to.equal(tr[1]);

					const community = [...flop, tr[0], tr[1]];

					if (decisionRiver(hole, community)) {
						playAmount = 1n * ante;
						const dealerHole = partialFisherYates(deckExcluding([...hole, ...community]), 2, word4);
						playerSeven = [...hole, ...community];
						dealerSeven = [...dealerHole, ...community];

						await (await uth.connect(player).makeAction(betId, 4)).wait();
						const reqId4r = await vrf.lastRequestId();
						await vrf.fulfillRandomWords(coreAddr, reqId4r, [word4]);
					} else {
						// Fold
						await uth.connect(player).makeAction(betId, 5);
						const base = await uth.getBetBase(betId);
						expect(Number(base.outcome), `fold outcome bet ${i}`).to.equal(Outcome.FOLDED);
						outcomes.folded++;
						// Forfeit ante + blind; payout = 0
						if ((i + 1) % PROGRESS_EVERY === 0) {
							const e = ((Date.now() - startTime) / 1000).toFixed(1);
							console.log(
								`  ${(i + 1).toString().padStart(5)}/${N_BETS}   ${e}s   ${JSON.stringify(
									outcomes
								)}`
							);
						}
						continue;
					}
				}
			}

			// Resolved — verify
			stake += playAmount;
			const expected = computeResolution(playerSeven, dealerSeven, ante, playAmount);

			const base = await uth.getBetBase(betId);
			expect(Number(base.outcome), `outcome bet ${i}`).to.equal(expected.outcome);

			const payouts = await uth.getBetPayouts(betId);
			expect(payouts.antePayout, `ante payout bet ${i}`).to.equal(expected.antePayout);
			expect(payouts.playPayout, `play payout bet ${i}`).to.equal(expected.playPayout);
			expect(payouts.blindPayout, `blind payout bet ${i}`).to.equal(expected.blindPayout);

			payout += expected.antePayout + expected.playPayout + expected.blindPayout;

			if (expected.outcome === Outcome.DEALER_NOT_QUALIFIED) outcomes.dnq++;
			else if (expected.outcome === Outcome.PLAYER_WIN) outcomes.win++;
			else if (expected.outcome === Outcome.DEALER_WIN) outcomes.loss++;
			else if (expected.outcome === Outcome.TIE) outcomes.tie++;

			if ((i + 1) % PROGRESS_EVERY === 0) {
				const e = ((Date.now() - startTime) / 1000).toFixed(1);
				console.log(
					`  ${(i + 1).toString().padStart(5)}/${N_BETS}   ${e}s   ${JSON.stringify(outcomes)}`
				);
			}
		}

		const rtp = Number((payout * 1_000_000n) / stake) / 1_000_000;
		console.log('');
		console.log(`========== AGGREGATE RESULTS (${N_BETS} bets) ==========`);
		console.log(`Outcomes: ${JSON.stringify(outcomes)}`);
		console.log(`Total wagered (ante+blind+play): ${stake}`);
		console.log(`Total returned: ${payout}`);
		console.log(
			`Realized RTP: ${(rtp * 100).toFixed(4)}%   (EoR ${((1 - rtp) * 100).toFixed(4)}%)`
		);
		console.log(`Per-bet invariants all matched.`);
	});
});
