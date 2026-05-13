// ============================================================================
// OvertimeBonusHoldem Cross-Validation — multi-decision flow through
// MockVRFCoordinator. Per-bet asserts hole cards, flop/turn/river, dealer hole,
// per-leg payouts (ante, bonus, play, flop, turn, river) against the off-chain
// model.
//
// Strategy (deterministic; must match on both sides):
//   pre-flop:  always Play 2× (mandatory commit; fold path tested separately)
//   flop:      raise if 5-card eval >= TWO_PAIR using ≥1 hole card; else check
//   turn:      raise if 7-card eval >= TWO_PAIR or pair using ≥1 hole card; else check
//   river:     raise if 7-card eval >= PAIR using ≥1 hole card; else check
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

const Outcome = { NONE: 0, FOLDED: 1, PLAYER_WIN: 2, DEALER_WIN: 3, TIE: 4 };

const BONUS_MULT_AA_VS_AA = 500;
const BONUS_MULT_AA = 31;
const BONUS_MULT_AK_S = 26;
const BONUS_MULT_AQ_AJ_S = 21;
const BONUS_MULT_AK = 16;
const BONUS_MULT_JJ_QQ_KK = 11;
const BONUS_MULT_AQ_AJ = 6;
const BONUS_MULT_LOW_PAIR = 4;

const RANK_TEN = 10;
const RANK_JACK = 11;
const RANK_QUEEN = 12;
const RANK_KING = 13;
const RANK_ACE = 14;

function wordFromSeed(seed) {
	return BigInt('0x' + ethers.id(`bh-xval-${seed}`).slice(2));
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

function topNExcluding(mask, n, ex0 = 0, ex1 = 0, ex2 = 0) {
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
		const k = topNExcluding(rankMask, 1, fourRank)[0];
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
		const ks = topNExcluding(rankMask, 2, firstThree);
		return packHand(HandClass.THREE_OF_A_KIND, firstThree, ks[0], ks[1]);
	}
	if (firstPair > 0 && secondPair > 0) {
		const ks = topNExcluding(rankMask, 1, firstPair, secondPair);
		return packHand(HandClass.TWO_PAIR, firstPair, secondPair, ks[0]);
	}
	if (firstPair > 0) {
		const ks = topNExcluding(rankMask, 3, firstPair);
		return packHand(HandClass.PAIR, firstPair, ks[0], ks[1], ks[2]);
	}
	const hc = topNRanks(rankMask, 5);
	return packHand(HandClass.HIGH_CARD, hc[0], hc[1], hc[2], hc[3], hc[4]);
}

function unpackClass(h) {
	return (h >> 20) & 0xf;
}

function bonusMultPlayerOnly(pr0, pr1, ps0, ps1) {
	const isPair = pr0 === pr1;
	const hi = Math.max(pr0, pr1);
	const lo = Math.min(pr0, pr1);
	const suited = ps0 === ps1;
	if (!isPair && hi === RANK_ACE) {
		if (suited) {
			if (lo === RANK_KING) return BONUS_MULT_AK_S;
			if (lo === RANK_QUEEN || lo === RANK_JACK) return BONUS_MULT_AQ_AJ_S;
		} else {
			if (lo === RANK_KING) return BONUS_MULT_AK;
			if (lo === RANK_QUEEN || lo === RANK_JACK) return BONUS_MULT_AQ_AJ;
		}
		return 0;
	}
	if (isPair) {
		if (pr0 === RANK_JACK || pr0 === RANK_QUEEN || pr0 === RANK_KING) return BONUS_MULT_JJ_QQ_KK;
		if (pr0 >= 2 && pr0 <= RANK_TEN) return BONUS_MULT_LOW_PAIR;
	}
	return 0;
}

function computeBonus(hole, dealerHole, bonusStake) {
	if (bonusStake === 0n) return 0n;
	const pr0 = rankOf(hole[0]);
	const pr1 = rankOf(hole[1]);
	const ps0 = suitOf(hole[0]);
	const ps1 = suitOf(hole[1]);
	const dr0 = rankOf(dealerHole[0]);
	const dr1 = rankOf(dealerHole[1]);
	const playerAA = pr0 === RANK_ACE && pr1 === RANK_ACE;
	const dealerAA = dr0 === RANK_ACE && dr1 === RANK_ACE;
	let mult;
	if (playerAA && dealerAA) mult = BONUS_MULT_AA_VS_AA;
	else if (playerAA) mult = BONUS_MULT_AA;
	else mult = bonusMultPlayerOnly(pr0, pr1, ps0, ps1);
	return mult === 0 ? 0n : bonusStake * BigInt(mult);
}

function antePayoutMult(handValue) {
	const cls = unpackClass(handValue);
	return cls >= HandClass.STRAIGHT ? 2n : 1n;
}

// Strategy: post-flop raise decisions
function shouldRaiseFlop(hole, flop) {
	const five = [hole[0], hole[1], flop[0], flop[1], flop[2]];
	const ev = evaluateCards(five);
	const cls = unpackClass(ev);
	if (cls >= HandClass.TWO_PAIR) return true;
	if (cls === HandClass.PAIR) {
		const pairRank = (ev >> 16) & 0xf;
		if (rankOf(hole[0]) === pairRank || rankOf(hole[1]) === pairRank) return true;
	}
	return false;
}
function shouldRaiseTurn(hole, community4) {
	const six = [hole[0], hole[1], ...community4];
	const ev = evaluateCards(six);
	const cls = unpackClass(ev);
	if (cls >= HandClass.TWO_PAIR) return true;
	if (cls === HandClass.PAIR) {
		const pairRank = (ev >> 16) & 0xf;
		if (rankOf(hole[0]) === pairRank || rankOf(hole[1]) === pairRank) return true;
	}
	return false;
}
function shouldRaiseRiver(hole, community5) {
	const seven = [hole[0], hole[1], ...community5];
	const ev = evaluateCards(seven);
	const cls = unpackClass(ev);
	if (cls >= HandClass.TWO_PAIR) return true;
	if (cls === HandClass.PAIR) {
		const pairRank = (ev >> 16) & 0xf;
		if (rankOf(hole[0]) === pairRank || rankOf(hole[1]) === pairRank) return true;
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
	const BH = await ethers.getContractFactory('OvertimeBonusHoldem');
	const bh = await upgrades.deployProxy(BH, [], { initializer: false });
	const bhAddr = await bh.getAddress();
	await bh.initialize(owner.address, coreAddr, managerAddr);
	await core.registerGame(bhAddr);
	await core.setMaxNetLossPerGameUsd(bhAddr, ethers.parseEther('5000000'));
	await usdc.setDefaultAmount(1_000_000n * USDC_UNIT);
	await usdc.mintForUser(owner.address);
	await usdc.transfer(coreAddr, 200_000n * USDC_UNIT);
	await usdc.transfer(player.address, 200_000n * USDC_UNIT);
	await usdc.connect(player).approve(coreAddr, ethers.MaxUint256);
	return { bh, bhAddr, vrf, core, coreAddr, usdc, usdcAddr, player };
}

describe('OvertimeBonusHoldem Cross-Validation: real on-chain', () => {
	it(`places ${N_BETS.toLocaleString(
		'en-US'
	)} bets and per-bet asserts contract == off-chain model`, async function () {
		this.timeout(60 * 60 * 1000);

		const ctx = await loadFixture(deployFixture);
		const { bh, vrf, core, coreAddr, usdcAddr, player } = ctx;

		let totalStake = 0n;
		let totalPayout = 0n;
		const outcomes = { win: 0, loss: 0, tie: 0, folded: 0 };
		const startTime = Date.now();

		for (let i = 0; i < N_BETS; i++) {
			const ante = BET_AMOUNT;
			const bonus = i % 2 === 0 ? BET_AMOUNT : 0n;

			const wordHole = wordFromSeed(`b${i}-w1`);
			const wordFlop = wordFromSeed(`b${i}-w2`);
			const wordTurn = wordFromSeed(`b${i}-w3`);
			const wordRiver = wordFromSeed(`b${i}-w4`);
			const wordDealer = wordFromSeed(`b${i}-w5`);

			// Off-chain
			const hole = partialFisherYates(FULL_DECK, 2, wordHole);
			const flop = partialFisherYates(deckExcluding(hole), 3, wordFlop);
			const turn = partialFisherYates(deckExcluding([...hole, ...flop]), 1, wordTurn)[0];
			const river = partialFisherYates(deckExcluding([...hole, ...flop, turn]), 1, wordRiver)[0];
			const community = [...flop, turn, river];
			const dealerHole = partialFisherYates(deckExcluding([...hole, ...community]), 2, wordDealer);

			// Strategy: always play pre-flop (no fold path in this sim)
			const playStake = ante * 2n;
			const flopRaise = shouldRaiseFlop(hole, flop) ? ante : 0n;
			const turnRaise = shouldRaiseTurn(hole, [...flop, turn]) ? ante : 0n;
			const riverRaise = shouldRaiseRiver(hole, community) ? ante : 0n;

			// Expected payouts (for 1 semantics)
			const playerSeven = [...hole, ...community];
			const dealerSeven = [...dealerHole, ...community];
			const pVal = evaluateCards(playerSeven);
			const dVal = evaluateCards(dealerSeven);

			let outcome,
				antePayout = 0n,
				playPayout = 0n,
				flopPayout = 0n,
				turnPayout = 0n,
				riverPayout = 0n;
			if (pVal > dVal) {
				outcome = Outcome.PLAYER_WIN;
				antePayout = ante * antePayoutMult(pVal);
				playPayout = playStake * 2n;
				flopPayout = flopRaise * 2n;
				turnPayout = turnRaise * 2n;
				riverPayout = riverRaise * 2n;
				outcomes.win++;
			} else if (pVal < dVal) {
				outcome = Outcome.DEALER_WIN;
				outcomes.loss++;
			} else {
				outcome = Outcome.TIE;
				antePayout = ante;
				playPayout = playStake;
				flopPayout = flopRaise;
				turnPayout = turnRaise;
				riverPayout = riverRaise;
				outcomes.tie++;
			}
			const bonusPayout = computeBonus(hole, dealerHole, bonus);

			// Drive the contract
			const tx = await bh.connect(player).placeBet(usdcAddr, ante, bonus, ethers.ZeroAddress);
			const r1 = await tx.wait();
			const placed = parseEvent(bh.interface, r1, 'BetPlaced');
			const betId = placed.args.betId;
			await vrf.fulfillRandomWords(coreAddr, placed.args.requestId, [wordHole]);

			await (await bh.connect(player).playPreFlop(betId)).wait();
			await vrf.fulfillRandomWords(coreAddr, await vrf.lastRequestId(), [wordFlop]);

			if (flopRaise > 0n) await (await bh.connect(player).raiseFlop(betId)).wait();
			else await (await bh.connect(player).checkFlop(betId)).wait();
			await vrf.fulfillRandomWords(coreAddr, await vrf.lastRequestId(), [wordTurn]);

			if (turnRaise > 0n) await (await bh.connect(player).raiseTurn(betId)).wait();
			else await (await bh.connect(player).checkTurn(betId)).wait();
			await vrf.fulfillRandomWords(coreAddr, await vrf.lastRequestId(), [wordRiver]);

			if (riverRaise > 0n) await (await bh.connect(player).raiseRiver(betId)).wait();
			else await (await bh.connect(player).checkRiver(betId)).wait();
			await vrf.fulfillRandomWords(coreAddr, await vrf.lastRequestId(), [wordDealer]);

			const full = await bh.getFullRecord(betId);

			// Per-bet assertions
			for (let k = 0; k < 2; k++) {
				expect(Number(full.playerHole[k]), `hole[${k}] bet ${i}`).to.equal(hole[k]);
			}
			for (let k = 0; k < 5; k++) {
				expect(Number(full.community[k]), `community[${k}] bet ${i}`).to.equal(community[k]);
			}
			for (let k = 0; k < 2; k++) {
				expect(Number(full.dealerHole[k]), `dealerHole[${k}] bet ${i}`).to.equal(dealerHole[k]);
			}
			expect(Number(full.outcome), `outcome bet ${i}`).to.equal(outcome);
			expect(full.antePayout, `antePay bet ${i}`).to.equal(antePayout);
			expect(full.playPayout, `playPay bet ${i}`).to.equal(playPayout);
			expect(full.flopPayout, `flopPay bet ${i}`).to.equal(flopPayout);
			expect(full.turnPayout, `turnPay bet ${i}`).to.equal(turnPayout);
			expect(full.riverPayout, `riverPay bet ${i}`).to.equal(riverPayout);
			expect(full.bonusPayout, `bonusPay bet ${i}`).to.equal(bonusPayout);

			const stake = ante + bonus + playStake + flopRaise + turnRaise + riverRaise;
			const payout = antePayout + playPayout + flopPayout + turnPayout + riverPayout + bonusPayout;
			totalStake += stake;
			totalPayout += payout;

			if ((i + 1) % PROGRESS_EVERY === 0) {
				const e = ((Date.now() - startTime) / 1000).toFixed(1);
				console.log(
					`  ${(i + 1).toString().padStart(5)}/${N_BETS}   ${e}s   ${JSON.stringify(outcomes)}`
				);
			}
		}

		const rtp = Number((totalPayout * 1_000_000n) / totalStake) / 1_000_000;
		console.log('');
		console.log(`========== AGGREGATE RESULTS (${N_BETS} bets) ==========`);
		console.log(`Outcomes: ${JSON.stringify(outcomes)}`);
		console.log(
			`Realized RTP: ${(rtp * 100).toFixed(4)}%   (EoR ${((1 - rtp) * 100).toFixed(4)}%)`
		);
		console.log(`Per-bet invariants all matched.`);
	});
});
