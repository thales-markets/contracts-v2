// ============================================================================
// ThreeCardPoker Cross-Validation — places N bets through MockVRFCoordinator
// with Q-6-4 play/fold strategy. Per-bet asserts player cards, PP payout,
// play/fold decision outcome, dealer cards (if played), and final payouts all
// match off-chain prediction.
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
const ONE = 10n ** 18n;
const BET_AMOUNT = 3n * USDC_UNIT;

const N_BETS = Number(process.env.N_BETS || 1000);
const PROGRESS_EVERY = 100;

const DECK_SIZE = 52;
const CARDS_PER_HAND = 3;
const SHIFT = 16n;
const MASK = 0xffffn;

const HandClass = {
	HIGH_CARD: 0,
	PAIR: 1,
	FLUSH: 2,
	STRAIGHT: 3,
	THREE_OF_A_KIND: 4,
	STRAIGHT_FLUSH: 5,
};
const Outcome = {
	NONE: 0,
	FOLDED: 1,
	DEALER_NOT_QUALIFIED: 2,
	PLAYER_WIN: 3,
	DEALER_WIN: 4,
	TIE: 5,
};

const ANTE_BONUS = {
	[HandClass.STRAIGHT_FLUSH]: 5,
	[HandClass.THREE_OF_A_KIND]: 4,
	[HandClass.STRAIGHT]: 1,
};
const PAIR_PLUS = {
	[HandClass.STRAIGHT_FLUSH]: 40,
	[HandClass.THREE_OF_A_KIND]: 30,
	[HandClass.STRAIGHT]: 6,
	[HandClass.FLUSH]: 4,
	[HandClass.PAIR]: 1,
};

function wordFromSeed(seed) {
	return BigInt('0x' + ethers.id(`tcp-xval-${seed}`).slice(2));
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
	const out = [];
	for (let i = 0; i < n; i++) {
		const rem = BigInt(d.length - i);
		const j = i + Number((cursor & MASK) % rem);
		cursor >>= SHIFT;
		[d[i], d[j]] = [d[j], d[i]];
		out.push(d[i]);
	}
	return out;
}

const FULL_DECK = Array.from({ length: DECK_SIZE }, (_, i) => i);

function evaluate3Card(cards) {
	const ranks = cards.map(rankOf).sort((a, b) => b - a);
	const [hi, mid, lo] = ranks;
	const suits = cards.map(suitOf);
	const isFlush = suits[0] === suits[1] && suits[1] === suits[2];
	let isStraight = false;
	let topRank = hi;
	if (hi - lo === 2 && hi - mid === 1) isStraight = true;
	else if (hi === 14 && mid === 3 && lo === 2) {
		isStraight = true;
		topRank = 3;
	}
	if (hi === lo) return { class_: HandClass.THREE_OF_A_KIND, tie: hi };
	if (isStraight && isFlush) return { class_: HandClass.STRAIGHT_FLUSH, tie: topRank };
	if (isStraight) return { class_: HandClass.STRAIGHT, tie: topRank };
	if (isFlush) return { class_: HandClass.FLUSH, tie: (hi << 16) | (mid << 8) | lo };
	if (hi === mid) return { class_: HandClass.PAIR, tie: (hi << 8) | lo };
	if (mid === lo) return { class_: HandClass.PAIR, tie: (mid << 8) | hi };
	return { class_: HandClass.HIGH_CARD, tie: (hi << 16) | (mid << 8) | lo };
}

function dealerQualifies(cards) {
	const ev = evaluate3Card(cards);
	if (ev.class_ > HandClass.HIGH_CARD) return true;
	return Math.max(...cards.map(rankOf)) >= 12;
}

function compareHands(p, d) {
	if (p.class_ !== d.class_) return p.class_ - d.class_;
	return p.tie - d.tie;
}

// Q-6-4 strategy
function shouldPlay(cards) {
	const ev = evaluate3Card(cards);
	if (ev.class_ >= HandClass.PAIR) return true;
	const ranks = cards.map(rankOf).sort((a, b) => b - a);
	const [hi, mid, lo] = ranks;
	if (hi > 12) return true;
	if (hi < 12) return false;
	if (mid > 6) return true;
	if (mid < 6) return false;
	return lo >= 4;
}

function expectedPPPayout(stakeBi, evClass) {
	const mult = PAIR_PLUS[evClass];
	if (!mult) return 0n;
	return stakeBi * BigInt(mult + 1);
}

function expectedAnteBonusPayout(stakeBi, evClass) {
	const mult = ANTE_BONUS[evClass];
	if (!mult) return 0n;
	return stakeBi * BigInt(mult);
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

	const TCP = await ethers.getContractFactory('ThreeCardPoker');
	const tcp = await upgrades.deployProxy(TCP, [], { initializer: false });
	const tcpAddr = await tcp.getAddress();
	await tcp.initialize(owner.address, coreAddr, managerAddr);
	await core.registerGame(tcpAddr);
	await core.setMaxNetLossPerGameUsd(tcpAddr, ethers.parseEther('5000000'));

	await usdc.setDefaultAmount(1_000_000n * USDC_UNIT);
	await usdc.mintForUser(owner.address);
	await usdc.transfer(coreAddr, 200_000n * USDC_UNIT);
	await usdc.transfer(player.address, 100_000n * USDC_UNIT);
	await usdc.connect(player).approve(coreAddr, ethers.MaxUint256);

	return { tcp, tcpAddr, vrf, core, coreAddr, usdc, usdcAddr, player };
}

describe('ThreeCardPoker Cross-Validation: real on-chain', () => {
	it(`places ${N_BETS.toLocaleString(
		'en-US'
	)} bets and asserts contract == off-chain model`, async function () {
		this.timeout(60 * 60 * 1000);

		const ctx = await loadFixture(deployFixture);
		const { tcp, vrf, core, coreAddr, usdcAddr, player } = ctx;

		let stake = 0n;
		let payout = 0n;
		const outcomes = { fold: 0, dnq: 0, win: 0, loss: 0, tie: 0 };
		const startTime = Date.now();

		for (let i = 0; i < N_BETS; i++) {
			const includePP = i % 2 === 0;
			const ante = BET_AMOUNT;
			const pp = includePP ? BET_AMOUNT : 0n;

			const word1 = wordFromSeed(`b${i}-w1`);
			const word2 = wordFromSeed(`b${i}-w2`);

			// Off-chain: predict player cards + PP payout
			const playerCards = partialFisherYates(FULL_DECK, CARDS_PER_HAND, word1);
			const pEv = evaluate3Card(playerCards);
			const expectedPP = expectedPPPayout(pp, pEv.class_);

			// Place
			const tx = await tcp.connect(player).placeBet(usdcAddr, ante, pp, ethers.ZeroAddress);
			const r1 = await tx.wait();
			const placed = parseEvent(tcp.interface, r1, 'BetPlaced');
			const betId = placed.args.betId;
			const reqId1 = placed.args.requestId;

			await vrf.fulfillRandomWords(coreAddr, reqId1, [word1]);

			// Verify player cards + PP payout
			const cards = await tcp.getBetCards(betId);
			for (let k = 0; k < 3; k++) {
				expect(Number(cards.playerCards[k]), `player card[${k}] bet ${i}`).to.equal(playerCards[k]);
			}
			const payouts1 = await tcp.getBetPayouts(betId);
			expect(payouts1.pairPlusPayout, `PP payout bet ${i}`).to.equal(expectedPP);

			stake += ante + pp;
			payout += expectedPP;

			// Decide play/fold
			const play = shouldPlay(playerCards);

			if (!play) {
				outcomes.fold++;
				await tcp.connect(player).fold(betId);
				const base = await tcp.getBetBase(betId);
				expect(Number(base.outcome)).to.equal(Outcome.FOLDED);
				// No additional payout on fold (PP already paid in VRF1)
			} else {
				stake += ante; // play stake = ante
				const tx2 = await tcp.connect(player).play(betId);
				const r2 = await tx2.wait();
				const played = parseEvent(tcp.interface, r2, 'PlayChosen');
				const reqId2 = played.args.requestId;
				await vrf.fulfillRandomWords(coreAddr, reqId2, [word2]);

				// Off-chain: dealer cards from 49-deck excluding player cards
				const dealerCards = partialFisherYates(
					FULL_DECK.filter((c) => !playerCards.includes(c)),
					CARDS_PER_HAND,
					word2
				);
				const dEv = evaluate3Card(dealerCards);
				const dealerQ = dealerQualifies(dealerCards);

				// Compute expected ante-side payout
				const anteBonus = expectedAnteBonusPayout(ante, pEv.class_);
				let anteAndPlay = 0n;
				let outcome;
				if (!dealerQ) {
					outcome = Outcome.DEALER_NOT_QUALIFIED;
					outcomes.dnq++;
					anteAndPlay = ante * 3n; // ante 1:1 + play push
				} else {
					const cmp = compareHands(pEv, dEv);
					if (cmp > 0) {
						outcome = Outcome.PLAYER_WIN;
						outcomes.win++;
						anteAndPlay = ante * 4n;
					} else if (cmp < 0) {
						outcome = Outcome.DEALER_WIN;
						outcomes.loss++;
						anteAndPlay = 0n;
					} else {
						outcome = Outcome.TIE;
						outcomes.tie++;
						anteAndPlay = ante * 2n;
					}
				}

				const cards2 = await tcp.getBetCards(betId);
				for (let k = 0; k < 3; k++) {
					expect(Number(cards2.dealerCards[k]), `dealer card[${k}] bet ${i}`).to.equal(
						dealerCards[k]
					);
				}

				const payouts2 = await tcp.getBetPayouts(betId);
				expect(payouts2.anteBonusPayout, `ante bonus bet ${i}`).to.equal(anteBonus);
				expect(payouts2.anteAndPlayPayout, `ante+play bet ${i}`).to.equal(anteAndPlay);
				const base2 = await tcp.getBetBase(betId);
				expect(Number(base2.outcome), `outcome bet ${i}`).to.equal(outcome);

				payout += anteAndPlay + anteBonus;
			}

			if ((i + 1) % PROGRESS_EVERY === 0) {
				const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
				console.log(
					`  ${(i + 1).toString().padStart(5)}/${N_BETS}   ${elapsed}s   fold=${
						outcomes.fold
					} dnq=${outcomes.dnq} win=${outcomes.win} loss=${outcomes.loss} tie=${outcomes.tie}`
				);
			}
		}

		const rtp = Number((payout * 1_000_000n) / stake) / 1_000_000;
		console.log('');
		console.log(`========== AGGREGATE RESULTS (${N_BETS} bets, Q-6-4 strategy) ==========`);
		console.log(`Realized RTP: ${(rtp * 100).toFixed(4)}%`);
		console.log(`Outcomes: ${JSON.stringify(outcomes)}`);
		console.log(`Per-bet invariants all matched.`);
	});
});
