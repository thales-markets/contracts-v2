/**
 * Rare-hand coverage: brute-force searches for VRF words that produce specific hand classes
 * (3-of-a-kind, flush, certain pair orderings, etc.) to cover the last evaluator branches in
 * TCP and Hold'em
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
const fullDeck = () => Array.from({ length: 52 }, (_, i) => i);
const rankOf = (c) => (c % 13) + 2;
const suitOf = (c) => Math.floor(c / 13);

function evalTcp(cards) {
	const ranks = cards.map(rankOf).sort((a, b) => b - a);
	const [hi, mid, lo] = ranks;
	const suits = cards.map(suitOf);
	const isFlush = suits[0] === suits[1] && suits[1] === suits[2];
	const isStraight = (hi - lo === 2 && hi - mid === 1) || (hi === 14 && mid === 3 && lo === 2);
	if (hi === lo) return 'TOK';
	if (isStraight && isFlush) return 'SF';
	if (isStraight) return 'STR';
	if (isFlush) return 'FL';
	if (hi === mid) return 'PAIR_HI'; // pair of high two
	if (mid === lo) return 'PAIR_LO'; // pair of low two
	return 'HC';
}

function findWord(predicate, prefix, max = 200000) {
	for (let i = 0; i < max; i++) {
		const w = BigInt('0x' + ethers.id(`${prefix}-${i}`).slice(2));
		if (predicate(w)) return w;
	}
	return null;
}

async function deployStack() {
	const [owner, riskManager, resolver, pauser, player, freeBetsHolderStub] =
		await ethers.getSigners();

	const ExoticUSDC = await ethers.getContractFactory('ExoticUSDC');
	const usdc = await ExoticUSDC.deploy();
	const usdcAddr = await usdc.getAddress();
	const ExoticUSD = await ethers.getContractFactory('ExoticUSD');
	const weth = await ExoticUSD.deploy();
	const over = await ExoticUSD.deploy();

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
			freeBetsHolder: freeBetsHolderStub.address,
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

	async function deployGame(name) {
		const Factory = await ethers.getContractFactory(name);
		const c = await upgrades.deployProxy(Factory, [], { initializer: false });
		await c.initialize(owner.address, coreAddr, managerAddr);
		await core.registerGame(await c.getAddress());
		await core.setMaxNetLossPerGameUsd(await c.getAddress(), ethers.parseEther('100000'));
		return c;
	}
	const tcp = await deployGame('ThreeCardPoker');

	await usdc.mintForUser(owner.address);
	await usdc.transfer(coreAddr, 4_000n * USDC_UNIT);
	await usdc.transfer(player.address, 500n * USDC_UNIT);
	await usdc.connect(player).approve(coreAddr, ethers.MaxUint256);

	return {
		owner,
		riskManager,
		resolver,
		player,
		usdc,
		usdcAddr,
		vrf,
		core,
		coreAddr,
		tcp,
		tcpAddr: await tcp.getAddress(),
	};
}

async function placeAndDeal(ctx, game, args, word) {
	const tx = await game.connect(ctx.player).placeBet(...args, false);
	const r = await tx.wait();
	const placed = r.logs
		.map((l) => {
			try {
				return game.interface.parseLog(l);
			} catch {
				return null;
			}
		})
		.find((e) => e?.name === 'BetPlaced');
	await ctx.vrf.fulfillRandomWords(ctx.coreAddr, placed.args.requestId, [word]);
	return placed.args.betId;
}

describe('Rare hand classes — coverage push', () => {
	let ctx;
	beforeEach(async () => {
		ctx = await loadFixture(deployStack);
	});

	describe('TCP eval branches', () => {
		it('hits 3-of-a-kind branch', async () => {
			const w = findWord((wd) => evalTcp(partialFisherYates(fullDeck(), 3, wd)) === 'TOK', 'tok');
			if (!w) {
				console.log('  (skip — 3oK not found in 200k)');
				return;
			}
			const id = await placeAndDeal(
				ctx,
				ctx.tcp,
				[ctx.usdcAddr, MIN_USDC_BET, MIN_USDC_BET, ethers.ZeroAddress],
				w
			);
			const payouts = await ctx.tcp.getBetPayouts(id);
			// Pair Plus 3oK = 30:1 → payout = 31x stake
			expect(payouts.pairPlusPayout).to.equal(MIN_USDC_BET * 31n);
		});

		it('hits non-straight FLUSH branch', async () => {
			const w = findWord((wd) => evalTcp(partialFisherYates(fullDeck(), 3, wd)) === 'FL', 'fl');
			expect(w).to.not.be.null;
			const id = await placeAndDeal(
				ctx,
				ctx.tcp,
				[ctx.usdcAddr, MIN_USDC_BET, MIN_USDC_BET, ethers.ZeroAddress],
				w
			);
			const payouts = await ctx.tcp.getBetPayouts(id);
			// Pair Plus Flush = 4:1 → payout = 5x stake
			expect(payouts.pairPlusPayout).to.equal(MIN_USDC_BET * 5n);
		});

		it('hits PAIR_HI branch (hi==mid) and PAIR_LO branch (mid==lo)', async () => {
			const wHi = findWord(
				(wd) => evalTcp(partialFisherYates(fullDeck(), 3, wd)) === 'PAIR_HI',
				'pH'
			);
			const wLo = findWord(
				(wd) => evalTcp(partialFisherYates(fullDeck(), 3, wd)) === 'PAIR_LO',
				'pL'
			);
			expect(wHi).to.not.be.null;
			expect(wLo).to.not.be.null;
			// Both pair words → Pair Plus 1:1
			const id1 = await placeAndDeal(
				ctx,
				ctx.tcp,
				[ctx.usdcAddr, MIN_USDC_BET, MIN_USDC_BET, ethers.ZeroAddress],
				wHi
			);
			const id2 = await placeAndDeal(
				ctx,
				ctx.tcp,
				[ctx.usdcAddr, MIN_USDC_BET, MIN_USDC_BET, ethers.ZeroAddress],
				wLo
			);
			expect((await ctx.tcp.getBetPayouts(id1)).pairPlusPayout).to.equal(MIN_USDC_BET * 2n);
			expect((await ctx.tcp.getBetPayouts(id2)).pairPlusPayout).to.equal(MIN_USDC_BET * 2n);
		});
	});

	describe('TCP cancel from various states', () => {
		it('admin cancel from AWAITING_RESOLVE', async () => {
			const w = findWord((wd) => evalTcp(partialFisherYates(fullDeck(), 3, wd)) === 'HC', 'hc');
			const id = await placeAndDeal(
				ctx,
				ctx.tcp,
				[ctx.usdcAddr, MIN_USDC_BET, 0n, ethers.ZeroAddress],
				w
			);
			await ctx.tcp.connect(ctx.player).makeAction(id, 0);
			await expect(ctx.tcp.connect(ctx.resolver).adminCancelBet(id)).to.not.be.reverted;
		});
	});
});
