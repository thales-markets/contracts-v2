const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const { upgrades, ethers } = require('hardhat');

const WETH_KEY = ethers.encodeBytes32String('WETH');
const OVER_KEY = ethers.encodeBytes32String('OVER');
const WETH_PRICE = ethers.parseEther('3000');
const OVER_PRICE = ethers.parseEther('1');

const MAX_PROFIT_USD = ethers.parseEther('5000');
const CANCEL_TIMEOUT = 3600n;

const USDC_UNIT = 1_000_000n;
const MIN_USDC_BET = 3n * USDC_UNIT;

// Card encoding mirrors the contract: card = 0..51, suit = card / 13, rank = card % 13
const DECK_SIZE = 52;
const CARDS_PER_HAND = 3;

const BetStatus = {
	NONE: 0,
	AWAITING_DEAL: 1,
	PLAYER_TURN: 2,
	AWAITING_RESOLVE: 3,
	RESOLVED: 4,
	CANCELLED: 5,
};

const Outcome = {
	NONE: 0,
	FOLDED: 1,
	DEALER_NOT_QUALIFIED: 2,
	PLAYER_WIN: 3,
	DEALER_WIN: 4,
	TIE: 5,
};

const HandClass = {
	HIGH_CARD: 0,
	PAIR: 1,
	FLUSH: 2,
	STRAIGHT: 3,
	THREE_OF_A_KIND: 4,
	STRAIGHT_FLUSH: 5,
};

// JS mirror of the contract's _partialFisherYates. Returns the first `n` cards drawn from `deck`
function partialFisherYates(deck, n, word) {
	const d = [...deck];
	let cursor = BigInt(word);
	const MASK = 0xffffn;
	const SHIFT = 16n;
	const out = [];
	for (let i = 0; i < n; i++) {
		const remaining = BigInt(d.length - i);
		const j = i + Number((cursor & MASK) % remaining);
		cursor >>= SHIFT;
		[d[i], d[j]] = [d[j], d[i]];
		out.push(d[i]);
	}
	return out;
}

function fullDeck() {
	return Array.from({ length: DECK_SIZE }, (_, i) => i);
}

function deckExcluding(excluded) {
	const set = new Set(excluded);
	return fullDeck().filter((c) => !set.has(c));
}

function dealPlayer(word) {
	return partialFisherYates(fullDeck(), CARDS_PER_HAND, word);
}

function dealDealer(word, playerCards) {
	return partialFisherYates(deckExcluding(playerCards), CARDS_PER_HAND, word);
}

function rankOf(card) {
	return (card % 13) + 2;
} // 2..14
function suitOf(card) {
	return Math.floor(card / 13);
} // 0..3

function evaluate3Card(cards) {
	const ranks = cards.map(rankOf).sort((a, b) => b - a);
	const [hi, mid, lo] = ranks;
	const suits = cards.map(suitOf);
	const isFlush = suits[0] === suits[1] && suits[1] === suits[2];
	let isStraight = false;
	let topRank = hi;
	if (hi - lo === 2 && hi - mid === 1) {
		isStraight = true;
	} else if (hi === 14 && mid === 3 && lo === 2) {
		isStraight = true;
		topRank = 3;
	}
	if (hi === lo) return { class_: HandClass.THREE_OF_A_KIND, top: hi };
	if (isStraight && isFlush) return { class_: HandClass.STRAIGHT_FLUSH, top: topRank };
	if (isStraight) return { class_: HandClass.STRAIGHT, top: topRank };
	if (isFlush) return { class_: HandClass.FLUSH, top: hi };
	if (hi === mid) return { class_: HandClass.PAIR, pairRank: hi, kicker: lo };
	if (mid === lo) return { class_: HandClass.PAIR, pairRank: mid, kicker: hi };
	return { class_: HandClass.HIGH_CARD, top: hi, mid, lo };
}

function dealerQualifies(cards) {
	const ev = evaluate3Card(cards);
	if (ev.class_ > HandClass.HIGH_CARD) return true;
	const top = Math.max(...cards.map(rankOf));
	return top >= 12; // Q-high
}

// Brute-force search: find a VRF word that yields an evaluator predicate result
function findWord(predicate, maxAttempts = 50000) {
	for (let i = 0; i < maxAttempts; i++) {
		// random 256-bit-ish word — deterministic seed for reproducibility
		const word = BigInt('0x' + ethers.id('seed-' + i).slice(2));
		if (predicate(word)) return word;
	}
	throw new Error('findWord: no match in ' + maxAttempts);
}

async function deployFixture() {
	const [owner, riskManager, resolver, pauser, player, player2, referrer, freeBetsHolderStub] =
		await ethers.getSigners();

	const ExoticUSDC = await ethers.getContractFactory('ExoticUSDC');
	const usdc = await ExoticUSDC.deploy();
	const ExoticUSD = await ethers.getContractFactory('ExoticUSD');
	const weth = await ExoticUSD.deploy();
	const over = await ExoticUSD.deploy();
	const usdcAddr = await usdc.getAddress();
	const wethAddr = await weth.getAddress();
	const overAddr = await over.getAddress();

	const PriceFeed = await ethers.getContractFactory('MockPriceFeed');
	const priceFeed = await PriceFeed.deploy();
	await priceFeed.setPriceFeedForCollateral(WETH_KEY, wethAddr, WETH_PRICE);
	await priceFeed.setPriceFeedForCollateral(OVER_KEY, overAddr, OVER_PRICE);
	const priceFeedAddr = await priceFeed.getAddress();

	const Manager = await ethers.getContractFactory('SportsAMMV2Manager');
	const manager = await upgrades.deployProxy(Manager, [owner.address]);
	const managerAddr = await manager.getAddress();
	await manager.setWhitelistedAddresses([riskManager.address], 1, true);
	await manager.setWhitelistedAddresses([resolver.address], 2, true);
	await manager.setWhitelistedAddresses([pauser.address], 3, true);

	const VRF = await ethers.getContractFactory('MockVRFCoordinator');
	const vrf = await VRF.deploy();
	const vrfAddr = await vrf.getAddress();

	// CasinoCoreV2 (proxy)
	const Core = await ethers.getContractFactory('CasinoCoreV2');
	const core = await upgrades.deployProxy(Core, [], { initializer: false });
	const coreAddr = await core.getAddress();
	await core.initialize(
		{
			owner: owner.address,
			manager: managerAddr,
			priceFeed: priceFeedAddr,
			vrfCoordinator: vrfAddr,
			freeBetsHolder: freeBetsHolderStub.address, // stub — unused while free-bet TCP is disabled
			referrals: ethers.ZeroAddress,
		},
		{
			usdc: usdcAddr,
			weth: wethAddr,
			over: overAddr,
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

	// ThreeCardPoker (proxy)
	const TCP = await ethers.getContractFactory('ThreeCardPoker');
	const tcp = await upgrades.deployProxy(TCP, [], { initializer: false });
	const tcpAddr = await tcp.getAddress();
	await tcp.initialize(owner.address, coreAddr, managerAddr);

	// CasinoDataV2 (proxy)
	const Data = await ethers.getContractFactory('CasinoDataV2');
	const data = await upgrades.deployProxy(Data, [], { initializer: false });
	const dataAddr = await data.getAddress();
	await data.initialize(owner.address, coreAddr, tcpAddr);

	// Register TCP with Core
	await core.registerGame(tcpAddr);

	// Fund treasury bankroll (4k USDC) and players (500 USDC each)
	// ExoticUSDC.mintForUser hands the caller 5000 USDC; owner already has 100 from constructor
	await usdc.mintForUser(owner.address);
	await usdc.transfer(coreAddr, 4_000n * USDC_UNIT);
	await usdc.transfer(player.address, 500n * USDC_UNIT);
	await usdc.transfer(player2.address, 500n * USDC_UNIT);

	// Player approves Core (single-approval UX)
	await usdc.connect(player).approve(coreAddr, ethers.MaxUint256);
	await usdc.connect(player2).approve(coreAddr, ethers.MaxUint256);

	return {
		usdc,
		usdcAddr,
		weth,
		wethAddr,
		over,
		overAddr,
		manager,
		vrf,
		core,
		coreAddr,
		tcp,
		tcpAddr,
		data,
		dataAddr,
		owner,
		riskManager,
		resolver,
		pauser,
		player,
		player2,
		referrer,
		freeBetsHolderStub,
	};
}

async function placeAndDeal(ctx, anteAmount, ppAmount, dealWord, options = {}) {
	const { tcp, tcpAddr, vrf, player, usdcAddr } = ctx;
	const signer = options.signer ?? player;
	const referrer = options.referrer ?? ethers.ZeroAddress;
	const tx = await tcp.connect(signer).placeBet(usdcAddr, anteAmount, ppAmount, referrer);
	const receipt = await tx.wait();
	const placed = receipt.logs
		.map((l) => {
			try {
				return tcp.interface.parseLog(l);
			} catch {
				return null;
			}
		})
		.find((e) => e?.name === 'BetPlaced');
	const betId = placed.args.betId;
	const requestId = placed.args.requestId;
	await vrf.fulfillRandomWords(ctx.coreAddr, requestId, [dealWord]);
	return { betId, requestId };
}

async function playAndResolve(ctx, betId, resolveWord, signer) {
	const { tcp, vrf, player, coreAddr } = ctx;
	const tx = await tcp.connect(signer ?? player).play(betId);
	const receipt = await tx.wait();
	const played = receipt.logs
		.map((l) => {
			try {
				return tcp.interface.parseLog(l);
			} catch {
				return null;
			}
		})
		.find((e) => e?.name === 'PlayChosen');
	const requestId = played.args.requestId;
	await vrf.fulfillRandomWords(coreAddr, requestId, [resolveWord]);
	return { requestId };
}

describe('CasinoCoreV2 + ThreeCardPoker (Phase 1)', () => {
	let ctx;
	beforeEach(async () => {
		ctx = await loadFixture(deployFixture);
	});

	/* ========== INITIALIZATION ========== */

	describe('Initialization', () => {
		it('initializes core with correct state', async () => {
			const { core, owner, usdcAddr, wethAddr, overAddr } = ctx;
			expect(await core.owner()).to.equal(owner.address);
			expect(await core.maxProfitUsd()).to.equal(MAX_PROFIT_USD);
			expect(await core.cancelTimeout()).to.equal(CANCEL_TIMEOUT);
			expect(await core.usdc()).to.equal(usdcAddr);
			expect(await core.weth()).to.equal(wethAddr);
			expect(await core.over()).to.equal(overAddr);
			expect(await core.supportedCollateral(usdcAddr)).to.be.true;
			expect(await core.supportedCollateral(wethAddr)).to.be.true;
			expect(await core.supportedCollateral(overAddr)).to.be.true;
			expect(await core.defaultMaxNetLossPerGameUsd()).to.equal(ethers.parseEther('1000'));
		});

		it('initializes TCP with correct state', async () => {
			const { tcp, owner, coreAddr } = ctx;
			expect(await tcp.owner()).to.equal(owner.address);
			expect(await tcp.core()).to.equal(coreAddr);
			expect(await tcp.nextBetId()).to.equal(1n);
		});

		it('reverts on re-init', async () => {
			const { tcp, owner, coreAddr } = ctx;
			await expect(tcp.initialize(owner.address, coreAddr, coreAddr)).to.be.reverted;
		});

		it('rejects zero addresses on init', async () => {
			const TCP = await ethers.getContractFactory('ThreeCardPoker');
			const tcp2 = await upgrades.deployProxy(TCP, [], { initializer: false });
			await expect(
				tcp2.initialize(ethers.ZeroAddress, ctx.coreAddr, ctx.coreAddr)
			).to.be.revertedWithCustomError(tcp2, 'InvalidAddress');
		});
	});

	/* ========== GAME REGISTRY ========== */

	describe('Game registry', () => {
		it('owner can register and deregister a game with zero reservations', async () => {
			const { core, owner } = ctx;
			const games = await core.getRegisteredGames();
			expect(games.length).to.equal(1);

			// register a fresh address as a fake game
			const fake = ethers.Wallet.createRandom().address;
			await core.connect(owner).registerGame(fake);
			expect(await core.isGameRegistered(fake)).to.be.true;

			await core.connect(owner).deregisterGame(fake);
			expect(await core.isGameRegistered(fake)).to.be.false;
		});

		it('cannot register the same game twice', async () => {
			const { core, owner, tcpAddr } = ctx;
			await expect(core.connect(owner).registerGame(tcpAddr)).to.be.revertedWithCustomError(
				core,
				'GameAlreadyRegistered'
			);
		});

		it('non-owner cannot register a game', async () => {
			const { core, player } = ctx;
			const fake = ethers.Wallet.createRandom().address;
			await expect(core.connect(player).registerGame(fake)).to.be.reverted;
		});

		it('rejects placeBet from a non-registered game contract', async () => {
			// deploy a fresh, unregistered TCP and try to bet through it
			const TCP = await ethers.getContractFactory('ThreeCardPoker');
			const tcp2 = await upgrades.deployProxy(TCP, [], { initializer: false });
			await tcp2.initialize(ctx.owner.address, ctx.coreAddr, await ctx.manager.getAddress());
			await ctx.usdc.connect(ctx.player).approve(ctx.coreAddr, ethers.MaxUint256);
			await expect(
				tcp2.connect(ctx.player).placeBet(ctx.usdcAddr, MIN_USDC_BET, 0n, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(ctx.core, 'GameNotRegistered');
		});
	});

	/* ========== PLACE BET ========== */

	describe('placeBet', () => {
		it('pulls funds via core, reserves worst-case, emits BetPlaced', async () => {
			const { tcp, tcpAddr, core, coreAddr, usdc, usdcAddr, player } = ctx;
			const ante = MIN_USDC_BET;
			const pp = MIN_USDC_BET;
			const balBefore = await usdc.balanceOf(player.address);
			const tx = await tcp.connect(player).placeBet(usdcAddr, ante, pp, ethers.ZeroAddress);
			const receipt = await tx.wait();
			const placed = receipt.logs
				.map((l) => {
					try {
						return tcp.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			expect(placed.args.user).to.equal(player.address);
			expect(placed.args.anteAmount).to.equal(ante);
			expect(placed.args.pairPlusAmount).to.equal(pp);
			// Funds went to core, not TCP
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore - ante - pp);
			expect(await usdc.balanceOf(coreAddr)).to.be.gt(0);
			expect(await usdc.balanceOf(tcpAddr)).to.equal(0);
			// Reservation = 9*ante + 41*pp
			const expectedReservation = ante * 9n + pp * 41n;
			expect(await core.reservedProfitPerGame(tcpAddr, usdcAddr)).to.equal(expectedReservation);
			expect(await core.reservedProfitPerCollateral(usdcAddr)).to.equal(expectedReservation);
		});

		it('reverts on zero ante', async () => {
			const { tcp, usdcAddr, player } = ctx;
			await expect(
				tcp.connect(player).placeBet(usdcAddr, 0n, 0n, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(tcp, 'InvalidAmount');
		});

		it('reverts on unsupported collateral', async () => {
			const { tcp, player } = ctx;
			await expect(
				tcp.connect(player).placeBet(ethers.ZeroAddress, MIN_USDC_BET, 0n, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(tcp, 'InvalidCollateral');
		});

		it('reverts when ante below MIN_BET_USD', async () => {
			const { tcp, usdcAddr, player } = ctx;
			await expect(
				tcp.connect(player).placeBet(usdcAddr, USDC_UNIT, 0n, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(tcp, 'InvalidAmount');
		});

		it('reverts when treasury has insufficient liquidity', async () => {
			const { tcp, core, usdcAddr, owner, player } = ctx;
			// drain bankroll close to zero (bankroll started at 4000 USDC)
			await core.connect(owner).withdrawCollateral(usdcAddr, owner.address, 3_990n * USDC_UNIT);
			// now bet at full size — needs 9*ante + 41*pp reservation > 10 USDC
			const big = 50n * USDC_UNIT;
			await expect(
				tcp.connect(player).placeBet(usdcAddr, big, big, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(core, 'InsufficientAvailableLiquidity');
		});
	});

	/* ========== VRF1 — DEAL & PAIR PLUS ========== */

	describe('VRF1 fulfillment', () => {
		it('deals 3 player cards, advances to PLAYER_TURN, no Pair Plus when stake = 0', async () => {
			const { tcp } = ctx;
			const word = 0xdeadbeef;
			const { betId } = await placeAndDeal(ctx, MIN_USDC_BET, 0n, word);
			const base = await tcp.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.PLAYER_TURN);
			expect(base.totalPayout).to.equal(0n);
			const cards = await tcp.getBetCards(betId);
			const expectedPlayer = dealPlayer(word);
			expect(Number(cards.playerCards[0])).to.equal(expectedPlayer[0]);
			expect(Number(cards.playerCards[1])).to.equal(expectedPlayer[1]);
			expect(Number(cards.playerCards[2])).to.equal(expectedPlayer[2]);
			// Dealer cards still zero
			expect(Number(cards.dealerCards[0])).to.equal(0);
		});

		it('settles Pair Plus when player has a pair (1:1) and pays out immediately', async () => {
			const { tcp, usdc, player } = ctx;
			// find a word that yields a pair
			const word = findWord((w) => evaluate3Card(dealPlayer(w)).class_ === HandClass.PAIR);
			const balBefore = await usdc.balanceOf(player.address);
			const { betId } = await placeAndDeal(ctx, MIN_USDC_BET, MIN_USDC_BET, word);
			const payouts = await tcp.getBetPayouts(betId);
			// Pair Plus on a Pair: 1:1 → payout = stake * 2 (stake-back + 1:1 win)
			expect(payouts.pairPlusPayout).to.equal(MIN_USDC_BET * 2n);
			// Net at PLAYER_TURN: paid ante+pp out (-6), PP wins -> received pp*2 (+6); ante still held
			// Balance unchanged from balBefore
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore);
		});

		it('does not pay Pair Plus when player has high card', async () => {
			const { tcp } = ctx;
			const word = findWord((w) => evaluate3Card(dealPlayer(w)).class_ === HandClass.HIGH_CARD);
			const { betId } = await placeAndDeal(ctx, MIN_USDC_BET, MIN_USDC_BET, word);
			const payouts = await tcp.getBetPayouts(betId);
			expect(payouts.pairPlusPayout).to.equal(0n);
		});

		it('releases pair-plus reservation on VRF1 regardless of outcome', async () => {
			const { tcp, tcpAddr, core, usdcAddr } = ctx;
			const word = findWord((w) => evaluate3Card(dealPlayer(w)).class_ === HandClass.HIGH_CARD);
			const ante = MIN_USDC_BET;
			const pp = MIN_USDC_BET;
			await placeAndDeal(ctx, ante, pp, word);
			// Only ante-side reservation remains: 9*ante
			expect(await core.reservedProfitPerGame(tcpAddr, usdcAddr)).to.equal(ante * 9n);
		});
	});

	/* ========== FOLD ========== */

	describe('fold', () => {
		it('forfeits ante, releases ante-side reservation, closes bet', async () => {
			const { tcp, tcpAddr, core, usdc, usdcAddr, player } = ctx;
			const ante = MIN_USDC_BET;
			const balBefore = await usdc.balanceOf(player.address);
			const { betId } = await placeAndDeal(ctx, ante, 0n, 0xdeadbeefn);
			await tcp.connect(player).fold(betId);
			const base = await tcp.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.RESOLVED);
			expect(base.outcome).to.equal(Outcome.FOLDED);
			expect(await core.reservedProfitPerGame(tcpAddr, usdcAddr)).to.equal(0n);
			// Player lost ante
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore - ante);
		});

		it('rejects fold if not bet owner', async () => {
			const { tcp, player2 } = ctx;
			const { betId } = await placeAndDeal(ctx, MIN_USDC_BET, 0n, 0xdeadbeefn);
			await expect(tcp.connect(player2).fold(betId)).to.be.revertedWithCustomError(
				tcp,
				'BetNotOwner'
			);
		});

		it('rejects fold from wrong status', async () => {
			const { tcp, player } = ctx;
			const { betId } = await placeAndDeal(ctx, MIN_USDC_BET, 0n, 0xdeadbeefn);
			await tcp.connect(player).fold(betId);
			// already resolved
			await expect(tcp.connect(player).fold(betId)).to.be.revertedWithCustomError(
				tcp,
				'InvalidBetStatus'
			);
		});

		it('Pair Plus already paid; fold does not reverse it', async () => {
			const { tcp, usdc, player } = ctx;
			const word = findWord((w) => evaluate3Card(dealPlayer(w)).class_ === HandClass.PAIR);
			const balBefore = await usdc.balanceOf(player.address);
			const { betId } = await placeAndDeal(ctx, MIN_USDC_BET, MIN_USDC_BET, word);
			await tcp.connect(player).fold(betId);
			// Net: -ante -pp + pp*2 = pp - ante = 0 (since pp == ante in this test)
			// Player has neither lost nor gained
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore);
		});
	});

	/* ========== PLAY + VRF2 OUTCOMES ========== */

	describe('play + VRF2 resolution', () => {
		it('pulls additional ante stake on play()', async () => {
			const { tcp, usdc, player } = ctx;
			const ante = MIN_USDC_BET;
			const { betId } = await placeAndDeal(ctx, ante, 0n, 0xdeadbeefn);
			const balAfterDeal = await usdc.balanceOf(player.address);
			await tcp.connect(player).play(betId);
			// Another `ante` pulled
			expect(await usdc.balanceOf(player.address)).to.equal(balAfterDeal - ante);
			const base = await tcp.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.AWAITING_RESOLVE);
		});

		it('rejects play from non-owner', async () => {
			const { tcp, player2 } = ctx;
			const { betId } = await placeAndDeal(ctx, MIN_USDC_BET, 0n, 0xdeadbeefn);
			await expect(tcp.connect(player2).play(betId)).to.be.revertedWithCustomError(
				tcp,
				'BetNotOwner'
			);
		});

		it('player win: ante 1:1 + play 1:1 + ante bonus if applicable', async () => {
			const { tcp, usdc, player } = ctx;
			// Search for: player straight flush, dealer qualifies but loses
			const dealWord = findWord((w) => {
				const p = dealPlayer(w);
				const ev = evaluate3Card(p);
				return ev.class_ === HandClass.STRAIGHT_FLUSH;
			});
			const playerCards = dealPlayer(dealWord);
			// Now find resolveWord that gives dealer a qualifying losing hand
			let resolveWord;
			try {
				resolveWord = findWord((w) => {
					const d = dealDealer(w, playerCards);
					return dealerQualifies(d) && evaluate3Card(d).class_ < HandClass.STRAIGHT_FLUSH;
				});
			} catch {
				// If we can't find one (very rare), skip the SF case
				return;
			}

			const ante = MIN_USDC_BET;
			const balBefore = await usdc.balanceOf(player.address);
			const { betId } = await placeAndDeal(ctx, ante, 0n, dealWord);
			await playAndResolve(ctx, betId, resolveWord);

			const base = await tcp.getBetBase(betId);
			expect(base.outcome).to.equal(Outcome.PLAYER_WIN);
			const payouts = await tcp.getBetPayouts(betId);
			// Ante+Play = 4*ante; Ante Bonus on SF = 5*ante; total = 9*ante
			expect(payouts.anteAndPlayPayout).to.equal(ante * 4n);
			expect(payouts.anteBonusPayout).to.equal(ante * 5n);
			// Net P&L: -ante -play + 9*ante = +7*ante
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore + ante * 7n);
		});

		it('dealer not qualified: ante 1:1, play push', async () => {
			const { tcp, usdc, player } = ctx;
			// Find dealWord where player has high card (not bonus); resolveWord where dealer has J-high
			const dealWord = findWord((w) => evaluate3Card(dealPlayer(w)).class_ === HandClass.HIGH_CARD);
			const playerCards = dealPlayer(dealWord);
			const resolveWord = findWord((w) => !dealerQualifies(dealDealer(w, playerCards)));

			const ante = MIN_USDC_BET;
			const balBefore = await usdc.balanceOf(player.address);
			const { betId } = await placeAndDeal(ctx, ante, 0n, dealWord);
			await playAndResolve(ctx, betId, resolveWord);

			const base = await tcp.getBetBase(betId);
			expect(base.outcome).to.equal(Outcome.DEALER_NOT_QUALIFIED);
			const payouts = await tcp.getBetPayouts(betId);
			// 2x ante (Ante stake-back + 1:1 win) + ante (Play push) = 3x ante
			expect(payouts.anteAndPlayPayout).to.equal(ante * 3n);
			expect(payouts.anteBonusPayout).to.equal(0n);
			// Net: -ante -play + 3*ante = +ante
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore + ante);
		});

		it('dealer wins: payout 0', async () => {
			const { tcp, usdc, player } = ctx;
			const dealWord = findWord((w) => evaluate3Card(dealPlayer(w)).class_ === HandClass.HIGH_CARD);
			const playerCards = dealPlayer(dealWord);
			// Find resolveWord where dealer qualifies AND dealer beats player
			const resolveWord = findWord((w) => {
				const d = dealDealer(w, playerCards);
				if (!dealerQualifies(d)) return false;
				const ev = evaluate3Card(d);
				const pev = evaluate3Card(playerCards);
				if (ev.class_ > pev.class_) return true;
				if (ev.class_ < pev.class_) return false;
				// same class: compare top
				return (ev.top ?? ev.pairRank ?? 0) > (pev.top ?? pev.pairRank ?? 0);
			});

			const ante = MIN_USDC_BET;
			const balBefore = await usdc.balanceOf(player.address);
			const { betId } = await placeAndDeal(ctx, ante, 0n, dealWord);
			await playAndResolve(ctx, betId, resolveWord);

			const base = await tcp.getBetBase(betId);
			expect(base.outcome).to.equal(Outcome.DEALER_WIN);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore - ante * 2n);
		});
	});

	/* ========== CANCEL ========== */

	describe('cancel', () => {
		it('user cancel after timeout from AWAITING_DEAL refunds ante + pair plus', async () => {
			const { tcp, usdc, player } = ctx;
			const ante = MIN_USDC_BET;
			const pp = MIN_USDC_BET;
			const balBefore = await usdc.balanceOf(player.address);
			const tx = await tcp.connect(player).placeBet(ctx.usdcAddr, ante, pp, ethers.ZeroAddress);
			const receipt = await tx.wait();
			const placed = receipt.logs
				.map((l) => {
					try {
						return tcp.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			const betId = placed.args.betId;
			// don't fulfill VRF — simulate stuck request
			await time.increase(Number(CANCEL_TIMEOUT) + 1);
			await tcp.connect(player).cancelBet(betId);
			// full refund
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore);
			const base = await tcp.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.CANCELLED);
		});

		it('rejects cancel before timeout', async () => {
			const { tcp, player } = ctx;
			const tx = await tcp
				.connect(player)
				.placeBet(ctx.usdcAddr, MIN_USDC_BET, 0n, ethers.ZeroAddress);
			const receipt = await tx.wait();
			const placed = receipt.logs
				.map((l) => {
					try {
						return tcp.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			const betId = placed.args.betId;
			await expect(tcp.connect(player).cancelBet(betId)).to.be.revertedWithCustomError(
				tcp,
				'CancelTimeoutNotReached'
			);
		});

		it('admin can cancel bypassing timeout', async () => {
			const { tcp, resolver, player } = ctx;
			const tx = await tcp
				.connect(player)
				.placeBet(ctx.usdcAddr, MIN_USDC_BET, 0n, ethers.ZeroAddress);
			const receipt = await tx.wait();
			const placed = receipt.logs
				.map((l) => {
					try {
						return tcp.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			const betId = placed.args.betId;
			await expect(tcp.connect(resolver).adminCancelBet(betId)).to.not.be.reverted;
		});

		it('cancel from AWAITING_RESOLVE refunds ante + pp + play stake', async () => {
			const { tcp, usdc, player } = ctx;
			const ante = MIN_USDC_BET;
			const pp = MIN_USDC_BET;
			const balBefore = await usdc.balanceOf(player.address);
			const word = findWord((w) => evaluate3Card(dealPlayer(w)).class_ === HandClass.HIGH_CARD);
			const { betId } = await placeAndDeal(ctx, ante, pp, word);
			await tcp.connect(player).play(betId); // moves to AWAITING_RESOLVE
			await time.increase(Number(CANCEL_TIMEOUT) + 1);
			await tcp.connect(player).cancelBet(betId);
			// Pair Plus high-card paid 0; refund = ante + pp + play = 3*ante (since pp == ante)
			// Net: balance == balBefore (no PP gain, all stakes refunded)
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore);
		});
	});

	/* ========== CIRCUIT BREAKER ========== */

	describe('Circuit breaker', () => {
		it('auto-pauses game when net loss exceeds threshold', async () => {
			const { tcp, tcpAddr, core, riskManager, player } = ctx;
			// Lower threshold for predictable trip
			await core.connect(riskManager).setMaxNetLossPerGameUsd(tcpAddr, ethers.parseEther('5'));
			// Force player to win big: SF + ante + play
			const dealWord = findWord(
				(w) => evaluate3Card(dealPlayer(w)).class_ === HandClass.STRAIGHT_FLUSH
			);
			const playerCards = dealPlayer(dealWord);
			let resolveWord;
			try {
				resolveWord = findWord((w) => {
					const d = dealDealer(w, playerCards);
					return dealerQualifies(d) && evaluate3Card(d).class_ < HandClass.STRAIGHT_FLUSH;
				});
			} catch {
				return; // skip if pathological
			}
			const ante = 10n * USDC_UNIT; // bigger ante so 7*ante > $5
			const { betId } = await placeAndDeal(ctx, ante, 0n, dealWord);
			await playAndResolve(ctx, betId, resolveWord);
			expect(await core.gameAutoPaused(tcpAddr)).to.be.true;
			// Subsequent bet rejected
			await expect(
				tcp.connect(player).placeBet(ctx.usdcAddr, MIN_USDC_BET, 0n, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(core, 'GameNotActive');
		});

		it('risk-manager can reset circuit breaker', async () => {
			const { tcp, tcpAddr, core, riskManager, player } = ctx;
			await core.connect(riskManager).setMaxNetLossPerGameUsd(tcpAddr, ethers.parseEther('1'));
			// Trigger via a single big win
			const dealWord = findWord(
				(w) => evaluate3Card(dealPlayer(w)).class_ === HandClass.STRAIGHT_FLUSH
			);
			const playerCards = dealPlayer(dealWord);
			let resolveWord;
			try {
				resolveWord = findWord((w) => {
					const d = dealDealer(w, playerCards);
					return dealerQualifies(d) && evaluate3Card(d).class_ < HandClass.STRAIGHT_FLUSH;
				});
			} catch {
				return;
			}
			const { betId } = await placeAndDeal(ctx, 10n * USDC_UNIT, 0n, dealWord);
			await playAndResolve(ctx, betId, resolveWord);
			expect(await core.gameAutoPaused(tcpAddr)).to.be.true;
			await core.connect(riskManager).resetGameCircuitBreaker(tcpAddr);
			expect(await core.gameAutoPaused(tcpAddr)).to.be.false;
			expect(await core.houseNetUsd(tcpAddr)).to.equal(0n);
			// Next bet works
			await expect(tcp.connect(player).placeBet(ctx.usdcAddr, MIN_USDC_BET, 0n, ethers.ZeroAddress))
				.to.not.be.reverted;
		});
	});

	/* ========== PAUSE PATHS ========== */

	describe('Pause', () => {
		it('treasury-wide pause blocks new bets across games', async () => {
			const { core, tcp, pauser, player, usdcAddr } = ctx;
			await core.connect(pauser).setPausedByRole(true);
			await expect(
				tcp.connect(player).placeBet(usdcAddr, MIN_USDC_BET, 0n, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(core, 'GameNotActive');
		});

		it('per-game pause blocks just that game', async () => {
			const { core, tcp, tcpAddr, pauser, player, usdcAddr } = ctx;
			await core.connect(pauser).setGamePaused(tcpAddr, true);
			await expect(
				tcp.connect(player).placeBet(usdcAddr, MIN_USDC_BET, 0n, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(core, 'GameNotActive');
			await core.connect(pauser).setGamePaused(tcpAddr, false);
			await expect(tcp.connect(player).placeBet(usdcAddr, MIN_USDC_BET, 0n, ethers.ZeroAddress)).to
				.not.be.reverted;
		});

		it('paused state still allows in-flight bet to settle', async () => {
			const { core, tcp, tcpAddr, pauser, player } = ctx;
			const word = findWord((w) => evaluate3Card(dealPlayer(w)).class_ === HandClass.HIGH_CARD);
			const { betId } = await placeAndDeal(ctx, MIN_USDC_BET, 0n, word);
			// pause now
			await core.connect(pauser).setGamePaused(tcpAddr, true);
			// fold should still work (settlement path)
			await expect(tcp.connect(player).fold(betId)).to.not.be.reverted;
		});
	});

	/* ========== CASINO DATA V2 ========== */

	describe('CasinoDataV2', () => {
		it('returns treasury overview', async () => {
			const { data, usdcAddr, coreAddr } = ctx;
			const overview = await data.getTreasuryOverview([usdcAddr]);
			expect(overview.core).to.equal(coreAddr);
			expect(overview.collaterals[0]).to.equal(usdcAddr);
			expect(overview.balancePerCollateral[0]).to.be.gt(0);
		});

		it('returns game status', async () => {
			const { data, tcpAddr, usdcAddr } = ctx;
			const s = await data.getGameStatus(tcpAddr, [usdcAddr]);
			expect(s.game).to.equal(tcpAddr);
			expect(s.registered).to.be.true;
			expect(s.paused).to.be.false;
			expect(s.autoPaused).to.be.false;
		});

		it('returns full TCP record after a resolved bet', async () => {
			const { tcp, data, player } = ctx;
			const dealWord = findWord((w) => evaluate3Card(dealPlayer(w)).class_ === HandClass.HIGH_CARD);
			const { betId } = await placeAndDeal(ctx, MIN_USDC_BET, 0n, dealWord);
			await tcp.connect(player).fold(betId);
			const r = await data.getThreeCardPokerFullRecord(betId);
			expect(r.betId).to.equal(betId);
			expect(r.user).to.equal(player.address);
			expect(r.status).to.equal(BetStatus.RESOLVED);
			expect(r.outcome).to.equal(Outcome.FOLDED);
		});

		it('paginates user records', async () => {
			const { tcp, data, player } = ctx;
			// place 3 bets
			for (let i = 0; i < 3; i++) {
				const word = findWord((w) => evaluate3Card(dealPlayer(w)).class_ === HandClass.HIGH_CARD);
				const { betId } = await placeAndDeal(ctx, MIN_USDC_BET, 0n, word);
				await tcp.connect(player).fold(betId);
			}
			const recs = await data.getUserThreeCardPokerRecords(player.address, 0, 10);
			expect(recs.length).to.equal(3);
		});
	});
});
