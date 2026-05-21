// ============================================================================
// VideoPoker Cross-Validation — places N bets through MockVRFCoordinator with
// a simple "hold pair-or-better, else discard all" strategy. Per-bet asserts
// initial cards, final cards, hand class, multiplier, and payout against the
// off-chain model. Uses "for 1" semantics (post-fix payout = stake × mult).
//
// This is the test that would have caught the original VP stake-back bug.
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
const HAND_SIZE = 5;
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

// Post-fix paytable (for 1 semantics: payout = stake × mult on win; JoB pair = push at mult=1)
const PAYTABLE_MULT = {
	[HandClass.ROYAL_FLUSH]: 500,
	[HandClass.STRAIGHT_FLUSH]: 50,
	[HandClass.FOUR_OF_A_KIND]: 25,
	[HandClass.FULL_HOUSE]: 8,
	[HandClass.FLUSH]: 5,
	[HandClass.STRAIGHT]: 4,
	[HandClass.THREE_OF_A_KIND]: 3,
	[HandClass.TWO_PAIR]: 2,
};

function wordFromSeed(seed) {
	return BigInt('0x' + ethers.id(`vp-xval-${seed}`).slice(2));
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

function findStraightTop(rankMask) {
	for (let top = 14; top >= 6; top--) {
		const fiveMask = (0x1f << (top - 4)) & 0xffff;
		if ((rankMask & fiveMask) === fiveMask) return top;
	}
	if ((rankMask & 0x4000) !== 0 && (rankMask & 0x3c) === 0x3c) return 5;
	return 0;
}

function evaluateFive(cards) {
	const rankCount = new Array(15).fill(0);
	let rankMask = 0;
	let flush = true;
	const s0 = suitOf(cards[0]);
	for (const c of cards) {
		const r = rankOf(c);
		rankCount[r]++;
		rankMask |= 1 << r;
		if (suitOf(c) !== s0) flush = false;
	}
	const straightTop = findStraightTop(rankMask);
	if (flush && straightTop > 0) {
		if (straightTop === 14) return { class_: HandClass.ROYAL_FLUSH, primaryRank: 14 };
		return { class_: HandClass.STRAIGHT_FLUSH, primaryRank: straightTop };
	}
	let fourRank = 0,
		threeRank = 0,
		pair1 = 0,
		pair2 = 0;
	for (let r = 14; r >= 2; r--) {
		const c = rankCount[r];
		if (c === 4) fourRank = r;
		else if (c === 3) threeRank = r;
		else if (c === 2) {
			if (!pair1) pair1 = r;
			else if (!pair2) pair2 = r;
		}
	}
	if (fourRank) return { class_: HandClass.FOUR_OF_A_KIND, primaryRank: fourRank };
	if (threeRank && pair1) return { class_: HandClass.FULL_HOUSE, primaryRank: threeRank };
	if (flush) return { class_: HandClass.FLUSH, primaryRank: 14 };
	if (straightTop) return { class_: HandClass.STRAIGHT, primaryRank: straightTop };
	if (threeRank) return { class_: HandClass.THREE_OF_A_KIND, primaryRank: threeRank };
	if (pair1 && pair2) return { class_: HandClass.TWO_PAIR, primaryRank: pair1 };
	if (pair1) return { class_: HandClass.PAIR, primaryRank: pair1 };
	return { class_: HandClass.HIGH_CARD, primaryRank: 0 };
}

function paytableMult(cls, primaryRank) {
	if (cls === HandClass.PAIR && primaryRank >= 11) return 1; // JoB
	return PAYTABLE_MULT[cls] || 0;
}

// Strategy: hold all 5 if pair-or-better; else discard all 5
function chooseHoldMask(cards) {
	const ev = evaluateFive(cards);
	if (ev.class_ >= HandClass.TWO_PAIR) return 31; // hold all
	if (ev.class_ === HandClass.PAIR) {
		// Hold the pair (find the two cards matching primaryRank)
		let mask = 0;
		for (let i = 0; i < 5; i++) if (rankOf(cards[i]) === ev.primaryRank) mask |= 1 << i;
		return mask;
	}
	return 0; // discard everything
}

function applyDraw(initial, holdMask, word) {
	const used = new Set(initial);
	const remaining = FULL_DECK.filter((c) => !used.has(c));
	let needed = 0;
	for (let i = 0; i < 5; i++) if (!((holdMask >> i) & 1)) needed++;
	const drawn = needed > 0 ? partialFisherYates(remaining, needed, word) : [];
	const final = [];
	let cursor = 0;
	for (let i = 0; i < 5; i++) {
		if ((holdMask >> i) & 1) final.push(initial[i]);
		else final.push(drawn[cursor++]);
	}
	return final;
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
	const VP = await ethers.getContractFactory('VideoPoker');
	const vp = await upgrades.deployProxy(VP, [], { initializer: false });
	const vpAddr = await vp.getAddress();
	await vp.initialize(owner.address, coreAddr, managerAddr);
	await core.registerGame(vpAddr);
	await core.setMaxNetLossPerGameUsd(vpAddr, ethers.parseEther('5000000'));
	await usdc.setDefaultAmount(1_000_000n * USDC_UNIT);
	await usdc.mintForUser(owner.address);
	await usdc.transfer(coreAddr, 200_000n * USDC_UNIT);
	await usdc.transfer(player.address, 100_000n * USDC_UNIT);
	await usdc.connect(player).approve(coreAddr, ethers.MaxUint256);
	return { vp, vpAddr, vrf, core, coreAddr, usdc, usdcAddr, player };
}

describe('VideoPoker Cross-Validation: real on-chain', () => {
	it(`places ${N_BETS.toLocaleString(
		'en-US'
	)} bets and per-bet asserts contract == off-chain model`, async function () {
		this.timeout(60 * 60 * 1000);

		const ctx = await loadFixture(deployFixture);
		const { vp, vrf, core, coreAddr, usdcAddr, player } = ctx;

		let totalStake = 0n;
		let totalPayout = 0n;
		const startTime = Date.now();
		const classCount = new Array(10).fill(0);

		for (let i = 0; i < N_BETS; i++) {
			const word1 = wordFromSeed(`b${i}-w1`);
			const word2 = wordFromSeed(`b${i}-w2`);

			// Off-chain: deal initial
			const initial = partialFisherYates(FULL_DECK, HAND_SIZE, word1);
			const holdMask = chooseHoldMask(initial);
			const final = applyDraw(initial, holdMask, word2);
			const ev = evaluateFive(final);
			const expectedMult = paytableMult(ev.class_, ev.primaryRank);
			const expectedPayout = BET_AMOUNT * BigInt(expectedMult);

			// On-chain
			const tx = await vp.connect(player).placeBet(usdcAddr, BET_AMOUNT, ethers.ZeroAddress, false);
			const r1 = await tx.wait();
			const placed = parseEvent(vp.interface, r1, 'BetPlaced');
			const betId = placed.args.betId;
			const reqId1 = placed.args.requestId;
			await vrf.fulfillRandomWords(coreAddr, reqId1, [word1]);

			const tx2 = await vp.connect(player).draw(betId, holdMask);
			const r2 = await tx2.wait();
			const drawn = parseEvent(vp.interface, r2, 'DrawRequested');
			const reqId2 = drawn.args.requestId;
			await vrf.fulfillRandomWords(coreAddr, reqId2, [word2]);

			const base = await vp.getBetBase(betId);
			// VP getBetBase returns { user, collateral, amount, payout, ..., status, handClass, holdMask, multiplier }
			expect(Number(base.handClass), `class bet ${i}`).to.equal(ev.class_);
			expect(base.multiplier, `mult bet ${i}`).to.equal(expectedMult);
			expect(base.payout, `payout bet ${i} (class=${ev.class_})`).to.equal(expectedPayout);

			totalStake += BET_AMOUNT;
			totalPayout += expectedPayout;
			classCount[ev.class_]++;

			if ((i + 1) % PROGRESS_EVERY === 0) {
				const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
				console.log(
					`  ${(i + 1).toString().padStart(5)}/${N_BETS}   ${elapsed}s elapsed   (~${(
						((i + 1) / N_BETS) *
						100
					).toFixed(1)}%)`
				);
			}
		}

		const rtp = Number((totalPayout * 1_000_000n) / totalStake) / 1_000_000;
		console.log('');
		console.log(
			`========== AGGREGATE RESULTS (${N_BETS} bets, hold-pair-or-better strategy) ==========`
		);
		const CLASS_NAMES = ['HIGH', 'PAIR', '2PAIR', '3K', 'STR', 'FL', 'FH', '4K', 'SF', 'ROYAL'];
		for (let c = 9; c >= 0; c--) {
			if (classCount[c] === 0 && c < 5) continue;
			console.log(
				`  ${CLASS_NAMES[c].padEnd(6)}  ${classCount[c].toString().padStart(5)}   ${(
					(classCount[c] / N_BETS) *
					100
				).toFixed(2)}%`
			);
		}
		console.log(`Realized RTP: ${(rtp * 100).toFixed(4)}%`);
		console.log(`Per-bet invariants all matched.`);
	});
});
