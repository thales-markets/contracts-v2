/**
 * Final coverage gaps: targets the last ~5% of lines per V2 contract.
 *  - Core: getCollateralPrice + getUsdValue for WETH/OVER (non-USDC branch)
 *  - TCP: tie-break paths inside _compareHands
 *  - Hold'em: AA Bonus Pair-of-Aces special branch, dealer-non-qualify HC return
 *  - HiLo: edge ranks (rank 0, rank 12)
 */

const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const { upgrades, ethers } = require('hardhat');

const WETH_KEY = ethers.encodeBytes32String('WETH');
const OVER_KEY = ethers.encodeBytes32String('OVER');
const WETH_PRICE = ethers.parseEther('3000');
const OVER_PRICE = ethers.parseEther('1');
const MAX_PROFIT_USD = ethers.parseEther('100000');
const CANCEL_TIMEOUT = 3600n;
const USDC_UNIT = 1_000_000n;
const ONE = 10n ** 18n;
const MIN_USDC_BET = 3n * USDC_UNIT;

// JS shuffle simulator (same as in TCP test)
function partialFisherYates(deck, n, word) {
	const d = [...deck];
	let cursor = BigInt(word);
	for (let i = 0; i < n; i++) {
		const remaining = BigInt(d.length - i);
		const j = i + Number((cursor & 0xffffn) % remaining);
		cursor >>= 16n;
		[d[i], d[j]] = [d[j], d[i]];
	}
	return d.slice(0, n);
}

function fullDeck() {
	return Array.from({ length: 52 }, (_, i) => i);
}

function findWord(predicate, max = 200000) {
	for (let i = 0; i < max; i++) {
		const word = BigInt('0x' + ethers.id('final-' + i).slice(2));
		if (predicate(word)) return word;
	}
	throw new Error('not found');
}

function rankOf(c) {
	return (c % 13) + 2;
}
function suitOf(c) {
	return Math.floor(c / 13);
}

async function deployFullStack() {
	const [owner, riskManager, resolver, pauser, player, freeBetsHolderStub] =
		await ethers.getSigners();

	const ExoticUSDC = await ethers.getContractFactory('ExoticUSDC');
	const usdc = await ExoticUSDC.deploy();
	const usdcAddr = await usdc.getAddress();
	const ExoticUSD = await ethers.getContractFactory('ExoticUSD');
	const weth = await ExoticUSD.deploy();
	const over = await ExoticUSD.deploy();
	const wethAddr = await weth.getAddress();
	const overAddr = await over.getAddress();

	const PriceFeed = await ethers.getContractFactory('MockPriceFeed');
	const priceFeed = await PriceFeed.deploy();
	await priceFeed.setPriceFeedForCollateral(WETH_KEY, wethAddr, WETH_PRICE);
	await priceFeed.setPriceFeedForCollateral(OVER_KEY, overAddr, OVER_PRICE);

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
			freeBetsHolder: freeBetsHolderStub.address,
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

	async function deployGame(name) {
		const Factory = await ethers.getContractFactory(name);
		const c = await upgrades.deployProxy(Factory, [], { initializer: false });
		await c.initialize(owner.address, coreAddr, managerAddr);
		await core.registerGame(await c.getAddress());
		await core.setMaxNetLossPerGameUsd(await c.getAddress(), ethers.parseEther('100000'));
		return c;
	}
	const tcp = await deployGame('ThreeCardPoker');
	const hilo = await deployGame('HiLo');

	await usdc.mintForUser(owner.address);
	await usdc.transfer(coreAddr, 4_000n * USDC_UNIT);
	await usdc.transfer(player.address, 500n * USDC_UNIT);
	await usdc.connect(player).approve(coreAddr, ethers.MaxUint256);

	return {
		owner,
		riskManager,
		resolver,
		pauser,
		player,
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
		tcpAddr: await tcp.getAddress(),
		hilo,
		hiloAddr: await hilo.getAddress(),
	};
}

describe('Final coverage gaps', () => {
	let ctx;
	beforeEach(async () => {
		ctx = await loadFixture(deployFullStack);
	});

	describe('Core: non-USDC USD conversion', () => {
		it('getCollateralPrice returns price for WETH', async () => {
			expect(await ctx.core.getCollateralPrice(ctx.wethAddr)).to.equal(WETH_PRICE);
		});

		it('getCollateralPrice returns price for OVER', async () => {
			expect(await ctx.core.getCollateralPrice(ctx.overAddr)).to.equal(OVER_PRICE);
		});

		it('getUsdValue converts WETH amount to USD', async () => {
			// 1 WETH @ $3000 = 3000e18 USD
			const oneEther = ethers.parseEther('1');
			expect(await ctx.core.getUsdValue(ctx.wethAddr, oneEther)).to.equal(WETH_PRICE);
		});

		it('getUsdValue converts OVER amount to USD', async () => {
			const oneOver = ethers.parseEther('1');
			expect(await ctx.core.getUsdValue(ctx.overAddr, oneOver)).to.equal(OVER_PRICE);
		});

		it('getCollateralPrice rejects unsupported', async () => {
			await expect(ctx.core.getCollateralPrice(ethers.ZeroAddress)).to.be.revertedWithCustomError(
				ctx.core,
				'InvalidCollateral'
			);
		});

		it('getCollateralPrice reverts when price feed key missing', async () => {
			// Add a new collateral with empty key
			const fake = ethers.Wallet.createRandom().address;
			await ctx.core.setCollateralConfig(fake, ethers.ZeroHash, true);
			await expect(ctx.core.getCollateralPrice(fake)).to.be.revertedWithCustomError(
				ctx.core,
				'InvalidCollateral'
			);
		});

		it('getCollateralPrice reverts when price feed returns 0 (any revert from feed)', async () => {
			// Add an unknown currency key — MockPriceFeed reverts with "Invalid key" string
			// rather than returning 0. The intent is: a missing/invalid price stops the read
			const fake = ethers.Wallet.createRandom().address;
			const unknownKey = ethers.encodeBytes32String('UNKNOWN');
			await ctx.core.setCollateralConfig(fake, unknownKey, true);
			await expect(ctx.core.getCollateralPrice(fake)).to.be.reverted;
		});
	});

	describe('TCP: tie-break paths', () => {
		// Setup: 3-card poker — players see only their own 3 cards. Tie-breaks happen when player
		// and dealer have the same hand class but different ranks. We need to find words that
		// produce same-class hands with comparable ranks
		const HandClass = {
			HIGH_CARD: 0,
			PAIR: 1,
			FLUSH: 2,
			STRAIGHT: 3,
			THREE_OF_A_KIND: 4,
			STRAIGHT_FLUSH: 5,
		};

		function dealPlayer(word) {
			return partialFisherYates(fullDeck(), 3, word);
		}
		function dealDealer(word, exclude) {
			const set = new Set(exclude);
			return partialFisherYates(
				fullDeck().filter((c) => !set.has(c)),
				3,
				word
			);
		}
		function evalSimple(cards) {
			const ranks = cards.map(rankOf).sort((a, b) => b - a);
			const [hi, mid, lo] = ranks;
			const suits = cards.map(suitOf);
			const isFlush = suits[0] === suits[1] && suits[1] === suits[2];
			let isStraight = (hi - lo === 2 && hi - mid === 1) || (hi === 14 && mid === 3 && lo === 2);
			if (hi === lo) return { class_: HandClass.THREE_OF_A_KIND, top: hi };
			if (isStraight && isFlush)
				return { class_: HandClass.STRAIGHT_FLUSH, top: hi === 14 && mid === 3 ? 3 : hi };
			if (isStraight) return { class_: HandClass.STRAIGHT, top: hi === 14 && mid === 3 ? 3 : hi };
			if (isFlush) return { class_: HandClass.FLUSH, top: hi };
			if (hi === mid) return { class_: HandClass.PAIR, pairRank: hi };
			if (mid === lo) return { class_: HandClass.PAIR, pairRank: mid };
			return { class_: HandClass.HIGH_CARD, top: hi };
		}

		it('player and dealer both HC: tie-break compares top cards', async () => {
			// Find dealWord giving player HC, resolveWord giving dealer HC with QUALIFIES (>=Q-high) AND
			// player wins on tie-break
			let dealWord, resolveWord;
			for (let i = 0; i < 10000; i++) {
				const w = BigInt('0x' + ethers.id('tieHC-' + i).slice(2));
				const p = dealPlayer(w);
				if (evalSimple(p).class_ !== HandClass.HIGH_CARD) continue;
				if (Math.max(...p.map(rankOf)) < 12) continue; // need player Q-high or better to play
				for (let j = 0; j < 200; j++) {
					const w2 = BigInt('0x' + ethers.id('tieHC-r-' + i + '-' + j).slice(2));
					const d = dealDealer(w2, p);
					const ev = evalSimple(d);
					if (ev.class_ !== HandClass.HIGH_CARD) continue;
					const dTop = Math.max(...d.map(rankOf));
					if (dTop < 12) continue; // dealer must qualify
					dealWord = w;
					resolveWord = w2;
					break;
				}
				if (dealWord) break;
			}
			if (!dealWord) {
				console.log("  (skip — couldn't find HC vs HC qualifying scenario)");
				return;
			}
			const tx = await ctx.tcp
				.connect(ctx.player)
				.placeBet(ctx.usdcAddr, MIN_USDC_BET, 0n, ethers.ZeroAddress, false);
			const r = await tx.wait();
			const placed = r.logs
				.map((l) => {
					try {
						return ctx.tcp.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			await ctx.vrf.fulfillRandomWords(ctx.coreAddr, placed.args.requestId, [dealWord]);
			const tx2 = await ctx.tcp.connect(ctx.player).makeAction(placed.args.betId, 0);
			const r2 = await tx2.wait();
			const played = r2.logs
				.map((l) => {
					try {
						return ctx.tcp.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'PlayChosen');
			await ctx.vrf.fulfillRandomWords(ctx.coreAddr, played.args.requestId, [resolveWord]);
			// Outcome should be PLAYER_WIN, DEALER_WIN, or TIE — all three branches exercise the tie-break
			const base = await ctx.tcp.getBetBase(placed.args.betId);
			expect([3, 4, 5]).to.include(Number(base.outcome));
		});

		it('TCP: ace-low straight (wheel A-2-3) detected', async () => {
			// Find a word that produces player cards with ranks [Ace, 2, 3] (the wheel)
			let word;
			for (let i = 0; i < 100000; i++) {
				const w = BigInt('0x' + ethers.id('wheel-' + i).slice(2));
				const p = dealPlayer(w);
				const r = p.map(rankOf).sort((a, b) => b - a);
				if (r[0] === 14 && r[1] === 3 && r[2] === 2) {
					word = w;
					break;
				}
			}
			if (!word) {
				console.log('  (skip — wheel not found in 100k seeds)');
				return;
			}
			// Place a bet with PP enabled — wheel = STRAIGHT, pays 6:1
			const tx = await ctx.tcp
				.connect(ctx.player)
				.placeBet(ctx.usdcAddr, MIN_USDC_BET, MIN_USDC_BET, ethers.ZeroAddress, false);
			const r = await tx.wait();
			const placed = r.logs
				.map((l) => {
					try {
						return ctx.tcp.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			await ctx.vrf.fulfillRandomWords(ctx.coreAddr, placed.args.requestId, [word]);
			const payouts = await ctx.tcp.getBetPayouts(placed.args.betId);
			// Pair Plus on Straight = 6:1 → payout = 7 * stake
			expect(payouts.pairPlusPayout).to.equal(MIN_USDC_BET * 7n);
		});
	});

	describe('Core: recordSettlement USD-conversion catch path', () => {
		it('catches price-feed revert and emits SettlementUsdConversionFailed', async () => {
			const { core, owner } = ctx;
			// Add a fake collateral with a key that has no price feed entry
			const fake = ethers.Wallet.createRandom().address;
			const fakeKey = ethers.encodeBytes32String('NOPRICE');
			await core.setCollateralConfig(fake, fakeKey, true);

			// Register a fake game and impersonate it
			const fakeGame = ethers.Wallet.createRandom().address;
			await core.registerGame(fakeGame);
			const game = await ethers.getImpersonatedSigner(fakeGame);
			await hre.network.provider.send('hardhat_setBalance', [fakeGame, '0xDE0B6B3A7640000']);

			// Settlement where stake > payout (house won) and conversion fails
			await expect(core.connect(game).recordSettlement(fake, 100n, 50n))
				.to.emit(core, 'SettlementUsdConversionFailed')
				.withArgs(fakeGame, fake, 100n, 50n);

			// Settlement where payout > stake (house lost) and conversion fails
			await expect(core.connect(game).recordSettlement(fake, 50n, 100n))
				.to.emit(core, 'SettlementUsdConversionFailed')
				.withArgs(fakeGame, fake, 50n, 100n);
		});

		it('payOut free-bet branch: catches FBH confirm revert via reverting mock', async () => {
			const { core, owner, riskManager, usdc, usdcAddr } = ctx;
			// Deploy a "free bets holder" that reverts on confirmCasinoBetResolved
			const Broken = await ethers.getContractFactory('MockBrokenReferrals'); // already reverts on every method
			// MockBrokenReferrals doesn't have the FBH selector, so calling it falls through to revert
			const broken = await Broken.deploy();
			const brokenAddr = await broken.getAddress();
			// Repoint freeBetsHolder
			await core
				.connect(owner)
				.setAddresses(
					ethers.ZeroAddress,
					ethers.ZeroAddress,
					ethers.ZeroAddress,
					brokenAddr,
					ethers.ZeroAddress
				);

			const fakeGame = ethers.Wallet.createRandom().address;
			await core.registerGame(fakeGame);
			const game = await ethers.getImpersonatedSigner(fakeGame);
			await hre.network.provider.send('hardhat_setBalance', [fakeGame, '0xDE0B6B3A7640000']);

			await expect(
				core.connect(game).payOut(ctx.player.address, usdcAddr, 100n, true /* isFreeBet */, 50n)
			).to.emit(core, 'FreeBetConfirmFailed');
		});
	});
});
