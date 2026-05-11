const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
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

const POOL = 80;
const DRAW = 20;
const BetStatus = { NONE: 0, PENDING: 1, RESOLVED: 2, CANCELLED: 3 };

// JS mirror of Keno._drawNumbers — partial Fisher-Yates over 80 with cursor re-hash
function drawNumbers(word) {
	const deck = [];
	for (let i = 0; i < POOL; i++) deck.push(i + 1);
	let cursor = BigInt(word);
	let chunksLeft = 16;
	const drawn = [];
	for (let i = 0; i < DRAW; i++) {
		if (chunksLeft === 0) {
			cursor = BigInt(
				ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [cursor]))
			);
			chunksLeft = 16;
		}
		const remaining = BigInt(POOL - i);
		const j = i + Number((cursor & 0xffffn) % remaining);
		cursor >>= 16n;
		chunksLeft--;
		[deck[i], deck[j]] = [deck[j], deck[i]];
	}
	for (let i = 0; i < DRAW; i++) drawn.push(deck[i]);
	drawn.sort((a, b) => a - b);
	return drawn;
}

function picksToMask(picks) {
	let mask = 0n;
	for (const n of picks) mask |= 1n << BigInt(n - 1);
	return mask;
}

function countHits(picks, drawn) {
	const drawnSet = new Set(drawn);
	let h = 0;
	for (const p of picks) if (drawnSet.has(p)) h++;
	return h;
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
	const fbhAddr = await fbh.getAddress();

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
			freeBetsHolder: fbhAddr,
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

	const Keno = await ethers.getContractFactory('Keno');
	const keno = await upgrades.deployProxy(Keno, [], { initializer: false });
	const kenoAddr = await keno.getAddress();
	await keno.initialize(owner.address, coreAddr, managerAddr);
	await core.registerGame(kenoAddr);
	await core.setMaxNetLossPerGameUsd(kenoAddr, ethers.parseEther('1000000'));

	await usdc.mintForUser(owner.address);
	await usdc.transfer(coreAddr, 4_000n * USDC_UNIT);
	await usdc.transfer(player.address, 500n * USDC_UNIT);
	await usdc.connect(player).approve(coreAddr, ethers.MaxUint256);

	return {
		keno,
		kenoAddr,
		vrf,
		core,
		coreAddr,
		usdc,
		usdcAddr,
		fbh,
		fbhAddr,
		daoSink,
		owner,
		riskManager,
		resolver,
		pauser,
		player,
	};
}

async function placeAndFulfill(ctx, picks, amount, word) {
	const { keno, vrf, coreAddr, usdcAddr, player } = ctx;
	const tx = await keno.connect(player).placeBet(usdcAddr, amount, picks, ethers.ZeroAddress);
	const receipt = await tx.wait();
	const placed = receipt.logs
		.map((l) => {
			try {
				return keno.interface.parseLog(l);
			} catch {
				return null;
			}
		})
		.find((e) => e?.name === 'BetPlaced');
	const betId = placed.args.betId;
	await vrf.fulfillRandomWords(coreAddr, placed.args.requestId, [word]);
	return betId;
}

describe('CasinoCoreV2 + Keno', () => {
	let ctx;
	beforeEach(async () => {
		ctx = await loadFixture(deployFixture);
	});

	describe('Defaults', () => {
		it('initializes with paytables for picks 1..10, all entries ≤ 300x', async () => {
			const { keno } = ctx;
			for (let p = 1; p <= 10; p++) {
				const pt = await keno.getPaytable(p);
				expect(pt.length).to.equal(p + 1);
				for (const m of pt) {
					expect(m).to.be.lte(ethers.parseEther('300'));
				}
			}
			expect(await keno.getMaxMultiplierE18()).to.equal(ethers.parseEther('300'));
		});

		it('default paytables are strictly monotonic per spot count (no duplicate top tiers)', async () => {
			const { keno } = ctx;
			for (let p = 1; p <= 10; p++) {
				const pt = await keno.getPaytable(p);
				let lastNonZero = 0n;
				for (let h = 0; h < pt.length; h++) {
					const m = pt[h];
					if (m === 0n) continue;
					expect(m, `picks=${p} hits=${h} must be > prior`).to.be.gt(lastNonZero);
					lastNonZero = m;
				}
			}
		});

		it('sets configured constants', async () => {
			const { keno } = ctx;
			expect(await keno.POOL_SIZE()).to.equal(80);
			expect(await keno.DRAW_COUNT()).to.equal(20);
			expect(await keno.MIN_PICKS()).to.equal(1);
			expect(await keno.MAX_PICKS()).to.equal(10);
			expect(await keno.MIN_BET_USD()).to.equal(ethers.parseEther('3'));
			expect(await keno.MAX_BET_USD()).to.equal(ethers.parseEther('10'));
		});
	});

	describe('placeBet validation', () => {
		it('rejects picks length outside [1, 10]', async () => {
			const { keno, usdcAddr, player } = ctx;
			await expect(
				keno.connect(player).placeBet(usdcAddr, MIN_USDC_BET, [], ethers.ZeroAddress)
			).to.be.revertedWithCustomError(keno, 'InvalidPicks');
			const eleven = Array.from({ length: 11 }, (_, i) => i + 1);
			await expect(
				keno.connect(player).placeBet(usdcAddr, MIN_USDC_BET, eleven, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(keno, 'InvalidPicks');
		});

		it('rejects unsorted picks', async () => {
			const { keno, usdcAddr, player } = ctx;
			await expect(
				keno.connect(player).placeBet(usdcAddr, MIN_USDC_BET, [3, 1, 5], ethers.ZeroAddress)
			).to.be.revertedWithCustomError(keno, 'InvalidPicks');
		});

		it('rejects duplicate picks', async () => {
			const { keno, usdcAddr, player } = ctx;
			await expect(
				keno.connect(player).placeBet(usdcAddr, MIN_USDC_BET, [1, 1, 5], ethers.ZeroAddress)
			).to.be.revertedWithCustomError(keno, 'InvalidPicks');
		});

		it('rejects picks out of [1, 80]', async () => {
			const { keno, usdcAddr, player } = ctx;
			await expect(
				keno.connect(player).placeBet(usdcAddr, MIN_USDC_BET, [0, 5, 10], ethers.ZeroAddress)
			).to.be.revertedWithCustomError(keno, 'InvalidPicks');
			await expect(
				keno.connect(player).placeBet(usdcAddr, MIN_USDC_BET, [5, 10, 81], ethers.ZeroAddress)
			).to.be.revertedWithCustomError(keno, 'InvalidPicks');
		});

		it('rejects bet below MIN_BET_USD', async () => {
			const { keno, usdcAddr, player } = ctx;
			await expect(
				keno.connect(player).placeBet(usdcAddr, USDC_UNIT, [1], ethers.ZeroAddress)
			).to.be.revertedWithCustomError(keno, 'InvalidAmount');
		});

		it('rejects bet above MAX_BET_USD', async () => {
			const { keno, usdcAddr, player } = ctx;
			await expect(
				keno.connect(player).placeBet(usdcAddr, 11n * USDC_UNIT, [1], ethers.ZeroAddress)
			).to.be.revertedWithCustomError(keno, 'InvalidAmount');
		});

		it('rejects unsupported collateral', async () => {
			const { keno, player } = ctx;
			await expect(
				keno.connect(player).placeBet(ethers.ZeroAddress, MIN_USDC_BET, [1], ethers.ZeroAddress)
			).to.be.revertedWithCustomError(keno, 'InvalidCollateral');
		});

		it('rejects when maxProfit not enough for 300x cap', async () => {
			const { keno, core, usdcAddr, player } = ctx;
			// Tighten core's per-bet maxProfitUsd well below 300x × $3 = $900
			await core.setRiskParams(ethers.parseEther('100'), 0);
			await expect(
				keno.connect(player).placeBet(usdcAddr, MIN_USDC_BET, [5, 10], ethers.ZeroAddress)
			).to.be.revertedWithCustomError(keno, 'MaxProfitExceeded');
		});
	});

	describe('place + fulfill (happy path)', () => {
		it('resolves a Pick 1 bet, hit case', async () => {
			const word = 0x123456789abcdefn;
			const drawn = drawNumbers(word);
			// pick the first drawn number to guarantee a hit
			const picks = [drawn[0]];
			const id = await placeAndFulfill(ctx, picks, MIN_USDC_BET, word);
			const base = await ctx.keno.getBetBase(id);
			expect(Number(base.status)).to.equal(BetStatus.RESOLVED);
			expect(Number(base.hits)).to.equal(1);
			// Pick 1 paytable: [0, 3.92] → payout = 3 USDC × 3.92 = 11.76 USDC
			const expectedMult = ethers.parseEther('3.92');
			expect(base.multiplierE18).to.equal(expectedMult);
			expect(base.payout).to.equal((MIN_USDC_BET * expectedMult) / ONE);
		});

		it('resolves a Pick 5 bet with 0 hits → no payout', async () => {
			const word = 0x42n;
			const drawn = drawNumbers(word);
			// pick 5 numbers NOT in drawn
			const picks = [];
			for (let n = 1; n <= POOL && picks.length < 5; n++) {
				if (!drawn.includes(n)) picks.push(n);
			}
			const id = await placeAndFulfill(ctx, picks, MIN_USDC_BET, word);
			const base = await ctx.keno.getBetBase(id);
			expect(Number(base.hits)).to.equal(0);
			expect(base.payout).to.equal(0n);
		});

		it('drawnMask matches JS-derived draw and hit count is correct', async () => {
			const word = ethers.toBigInt(ethers.id('keno-test-1'));
			const drawn = drawNumbers(word);
			// pick a mix: 5 numbers, some hits, some misses
			const picks = [drawn[0], drawn[5], drawn[10]];
			// add 2 numbers not in drawn
			for (let n = 1; n <= POOL && picks.length < 5; n++) {
				if (!drawn.includes(n) && !picks.includes(n)) picks.push(n);
			}
			picks.sort((a, b) => a - b);
			const id = await placeAndFulfill(ctx, picks, MIN_USDC_BET, word);
			const base = await ctx.keno.getBetBase(id);

			const expectedDrawnMask = picksToMask(drawn);
			expect(base.drawnMask).to.equal(expectedDrawnMask);
			expect(Number(base.hits)).to.equal(countHits(picks, drawn));
		});
	});

	describe('cancel paths', () => {
		it('user cancel before timeout reverts', async () => {
			const { keno, usdcAddr, player } = ctx;
			const tx = await keno
				.connect(player)
				.placeBet(usdcAddr, MIN_USDC_BET, [1], ethers.ZeroAddress);
			const r = await tx.wait();
			const placed = r.logs
				.map((l) => {
					try {
						return keno.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			await expect(keno.connect(player).cancelBet(placed.args.betId)).to.be.revertedWithCustomError(
				keno,
				'CancelTimeoutNotReached'
			);
		});

		it('user cancel after timeout refunds full stake', async () => {
			const { keno, usdc, usdcAddr, player } = ctx;
			const balBefore = await usdc.balanceOf(player.address);
			const tx = await keno
				.connect(player)
				.placeBet(usdcAddr, MIN_USDC_BET, [1], ethers.ZeroAddress);
			const r = await tx.wait();
			const placed = r.logs
				.map((l) => {
					try {
						return keno.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			await time.increase(CANCEL_TIMEOUT + 1n);
			await keno.connect(player).cancelBet(placed.args.betId);
			const balAfter = await usdc.balanceOf(player.address);
			expect(balAfter).to.equal(balBefore);
		});

		it('admin can cancel before timeout', async () => {
			const { keno, usdcAddr, player, resolver } = ctx;
			const tx = await keno
				.connect(player)
				.placeBet(usdcAddr, MIN_USDC_BET, [1], ethers.ZeroAddress);
			const r = await tx.wait();
			const placed = r.logs
				.map((l) => {
					try {
						return keno.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			await expect(keno.connect(resolver).adminCancelBet(placed.args.betId)).to.not.be.reverted;
		});
	});

	describe('callback gating', () => {
		it('onVrfFulfilled rejects non-core sender', async () => {
			const { keno, player } = ctx;
			await expect(keno.connect(player).onVrfFulfilled(1, [42n])).to.be.revertedWithCustomError(
				keno,
				'InvalidSender'
			);
		});
	});

	describe('admin: setPaytable', () => {
		it('rejects mismatched length', async () => {
			const { keno } = ctx;
			await expect(
				keno.setPaytable(5, [0, 0, 0]) // wrong length (need 6)
			).to.be.revertedWithCustomError(keno, 'PaytableLengthMismatch');
		});

		it('rejects entries above 300x', async () => {
			const { keno } = ctx;
			const bad = [0, 0, 0, 0, 0, ethers.parseEther('301')];
			await expect(keno.setPaytable(5, bad)).to.be.revertedWithCustomError(
				keno,
				'MultiplierTooHigh'
			);
		});

		it('rejects picksCount outside [1, 10]', async () => {
			const { keno } = ctx;
			await expect(keno.setPaytable(0, [0])).to.be.revertedWithCustomError(keno, 'InvalidPicks');
			await expect(keno.setPaytable(11, [0])).to.be.revertedWithCustomError(keno, 'InvalidPicks');
		});

		it('owner can update a paytable', async () => {
			const { keno, owner } = ctx;
			const newPt = [0, ethers.parseEther('5')];
			await keno.connect(owner).setPaytable(1, newPt);
			const updated = await keno.getPaytable(1);
			expect(updated[1]).to.equal(ethers.parseEther('5'));
		});
	});

	describe('free bet (placeBetWithFreeBet)', () => {
		async function fundFB(ctx, amount) {
			const { fbh, fbhAddr, usdc, owner, player, usdcAddr } = ctx;
			await usdc.mintForUser(owner.address);
			await usdc.connect(owner).transfer(fbhAddr, amount);
			await fbh.setBalance(player.address, usdcAddr, amount);
		}

		it('reverts when FBH balance < stake', async () => {
			const { keno, usdcAddr, player } = ctx;
			await expect(
				keno.connect(player).placeBetWithFreeBet(usdcAddr, MIN_USDC_BET, [5], ethers.ZeroAddress)
			).to.be.revertedWith('MockFBH: InsufficientBalance');
		});

		it('place-time: debits FBH, does NOT touch user wallet', async () => {
			const { keno, fbh, usdc, usdcAddr, player } = ctx;
			await fundFB(ctx, MIN_USDC_BET);
			const balBefore = await usdc.balanceOf(player.address);
			await keno
				.connect(player)
				.placeBetWithFreeBet(usdcAddr, MIN_USDC_BET, [1, 2, 3], ethers.ZeroAddress);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore);
			expect(await fbh.balancePerUserAndCollateral(player.address, usdcAddr)).to.equal(0n);
		});

		it('zero-hit (no payout): no referrer fee on free bets', async () => {
			const { keno, vrf, coreAddr, fbh, usdc, usdcAddr, player } = ctx;
			await fundFB(ctx, MIN_USDC_BET);
			// Pick {1}, then find a word whose 20-draw excludes 1
			let word;
			for (let i = 0; i < 1000; i++) {
				const w = BigInt('0x' + ethers.id(`keno-fb-miss-${i}`).slice(2));
				if (!drawNumbers(w).includes(1)) {
					word = w;
					break;
				}
			}
			const tx = await keno
				.connect(player)
				.placeBetWithFreeBet(usdcAddr, MIN_USDC_BET, [1], ethers.ZeroAddress);
			const receipt = await tx.wait();
			const placed = receipt.logs
				.map((l) => {
					try {
						return keno.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			await vrf.fulfillRandomWords(coreAddr, placed.args.requestId, [word]);

			const base = await keno.getBetBase(placed.args.betId);
			expect(base.status).to.equal(BetStatus.RESOLVED);
			expect(base.payout).to.equal(0n);
			// No payout flowing through FBH → confirmCasinoBetResolved not called
			expect(await fbh.confirmCalls()).to.equal(0n);
		});

		it('cancel: stake refunded back to FBH balance (reusable)', async () => {
			const { keno, fbh, usdc, usdcAddr, player } = ctx;
			await fundFB(ctx, MIN_USDC_BET);
			const tx = await keno
				.connect(player)
				.placeBetWithFreeBet(usdcAddr, MIN_USDC_BET, [5, 10], ethers.ZeroAddress);
			const receipt = await tx.wait();
			const placed = receipt.logs
				.map((l) => {
					try {
						return keno.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			await time.increase(Number(CANCEL_TIMEOUT) + 1);
			await keno.connect(player).cancelBet(placed.args.betId);
			expect(await fbh.balancePerUserAndCollateral(player.address, usdcAddr)).to.equal(
				MIN_USDC_BET
			);
		});
	});
});
