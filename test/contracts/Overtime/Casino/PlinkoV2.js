const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const { upgrades, ethers } = require('hardhat');

const WETH_KEY = ethers.encodeBytes32String('WETH');
const OVER_KEY = ethers.encodeBytes32String('OVER');
const WETH_PRICE = ethers.parseEther('3000');
const OVER_PRICE = ethers.parseEther('1');
const MAX_PROFIT_USD = ethers.parseEther('100000'); // big — Plinko HIGH 16-row pays 900x
const CANCEL_TIMEOUT = 3600n;
const USDC_UNIT = 1_000_000n;
const ONE = 10n ** 18n;
const MIN_USDC_BET = 3n * USDC_UNIT;

const BetStatus = { NONE: 0, PENDING: 1, RESOLVED: 2, CANCELLED: 3 };
const Risk = { LOW: 0, MED: 1, HIGH: 2 };

function popcountLowBits(word, n) {
	const mask = (BigInt(1) << BigInt(n)) - 1n;
	let bits = BigInt(word) & mask;
	let c = 0;
	while (bits > 0n) {
		c += Number(bits & 1n);
		bits >>= 1n;
	}
	return c;
}

async function deployFixture() {
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

	const Plinko = await ethers.getContractFactory('Plinko');
	const plinko = await upgrades.deployProxy(Plinko, [], { initializer: false });
	const plinkoAddr = await plinko.getAddress();
	await plinko.initialize(owner.address, coreAddr, managerAddr);
	await core.registerGame(plinkoAddr);
	await core.connect(riskManager).setMaxNetLossPerGameUsd(plinkoAddr, ethers.parseEther('1000000'));

	const Data = await ethers.getContractFactory('CasinoDataV2');
	const data = await upgrades.deployProxy(Data, [], { initializer: false });
	await data.initialize(owner.address, coreAddr, ethers.ZeroAddress);
	await data.setPlinko(plinkoAddr);

	// Plinko HIGH 16-row max multiplier is 900x. With min bet $3 = 9_000_000 (6dec USDC),
	// reservation = 9_000_000 * 900 = 8_100_000_000 = 8100 USDC. Need bankroll ≥ that.
	// Mint additional liquidity into core
	await usdc.mintForUser(owner.address);
	await usdc.mintForUser(owner.address);
	await usdc.transfer(coreAddr, 9_000n * USDC_UNIT);
	await usdc.transfer(player.address, 500n * USDC_UNIT);
	await usdc.connect(player).approve(coreAddr, ethers.MaxUint256);

	return {
		plinko,
		plinkoAddr,
		vrf,
		core,
		coreAddr,
		usdc,
		usdcAddr,
		data,
		owner,
		riskManager,
		resolver,
		pauser,
		player,
	};
}

async function placeAndFulfill(ctx, amount, rows, risk, word) {
	const { plinko, vrf, coreAddr, usdcAddr, player } = ctx;
	const tx = await plinko
		.connect(player)
		.placeBet(usdcAddr, amount, rows, risk, ethers.ZeroAddress);
	const receipt = await tx.wait();
	const placed = receipt.logs
		.map((l) => {
			try {
				return plinko.interface.parseLog(l);
			} catch {
				return null;
			}
		})
		.find((e) => e?.name === 'BetPlaced');
	const betId = placed.args.betId;
	await vrf.fulfillRandomWords(coreAddr, placed.args.requestId, [word]);
	return betId;
}

describe('CasinoCoreV2 + Plinko (Phase 3)', () => {
	let ctx;
	beforeEach(async () => {
		ctx = await loadFixture(deployFixture);
	});

	describe('Defaults', () => {
		it('sets default paytables for all (rows, risk) combinations', async () => {
			const { plinko } = ctx;
			for (const rows of [8, 12, 16]) {
				for (const risk of [Risk.LOW, Risk.MED, Risk.HIGH]) {
					const pt = await plinko.getPaytable(rows, risk);
					expect(pt.length).to.equal(rows + 1);
					const max = await plinko.getMaxMultiplierE18(rows, risk);
					expect(max).to.be.gt(0n);
				}
			}
		});

		it('all default paytables clear ≥2% theoretical house edge', async () => {
			const { plinko } = ctx;
			const counts = {
				8: [1, 8, 28, 56, 70, 56, 28, 8, 1],
				12: [1, 12, 66, 220, 495, 792, 924, 792, 495, 220, 66, 12, 1],
				16: [
					1, 16, 120, 560, 1820, 4368, 8008, 11440, 12870, 11440, 8008, 4368, 1820, 560, 120, 16, 1,
				],
			};
			const totals = { 8: 256, 12: 4096, 16: 65536 };
			for (const rows of [8, 12, 16]) {
				for (const risk of [Risk.LOW, Risk.MED, Risk.HIGH]) {
					const pt = await plinko.getPaytable(rows, risk);
					let weighted = 0n;
					for (let i = 0; i < pt.length; i++) {
						weighted += BigInt(counts[rows][i]) * pt[i];
					}
					// EV per stake = weighted / total (in 18-dec)
					const evE18 = weighted / BigInt(totals[rows]);
					// HE = (1 - EV) → HE * 1e6 / 1e18 = (1e18 - evE18) * 1e6 / 1e18
					const heMicro = ((ONE - evE18) * 1_000_000n) / ONE; // HE in millionths
					const hePercent = Number(heMicro) / 10_000;
					// Sanity: ≥ 2%
					expect(hePercent, `rows=${rows} risk=${risk} HE=${hePercent}%`).to.be.gte(2.0);
				}
			}
		});
	});

	describe('placeBet', () => {
		it('reverts on zero amount', async () => {
			const { plinko, usdcAddr, player } = ctx;
			await expect(
				plinko.connect(player).placeBet(usdcAddr, 0n, 8, Risk.LOW, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(plinko, 'InvalidAmount');
		});

		it('reverts on unsupported rows', async () => {
			const { plinko, usdcAddr, player } = ctx;
			await expect(
				plinko.connect(player).placeBet(usdcAddr, MIN_USDC_BET, 10, Risk.LOW, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(plinko, 'InvalidRows');
		});

		it('reserves amount * maxMultiplier in core', async () => {
			const { plinko, plinkoAddr, core, usdc, usdcAddr, player } = ctx;
			const amount = MIN_USDC_BET;
			const balBefore = await usdc.balanceOf(player.address);
			await plinko.connect(player).placeBet(usdcAddr, amount, 8, Risk.HIGH, ethers.ZeroAddress);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore - amount);
			const maxMult = await plinko.getMaxMultiplierE18(8, Risk.HIGH);
			const expectedReservation = (amount * maxMult) / ONE;
			expect(await core.reservedProfitPerGame(plinkoAddr, usdcAddr)).to.equal(expectedReservation);
		});
	});

	describe('VRF resolution', () => {
		it('slot derivation matches popcount(low rows bits)', async () => {
			const { plinko, player } = ctx;
			// Word with bits: 0b1010_1010_1010_1010 = 0xAAAA — popcount of low 8 bits = 4
			const word = 0xaaaan;
			const betId = await placeAndFulfill(ctx, MIN_USDC_BET, 8, Risk.LOW, word);
			const base = await plinko.getBetBase(betId);
			expect(Number(base.slotIndex)).to.equal(popcountLowBits(word, 8));
			expect(base.status).to.equal(BetStatus.RESOLVED);
		});

		it('payout matches paytable lookup at slot index', async () => {
			const { plinko, player } = ctx;
			// Use an all-zero word → slot 0 → pays max for the leftmost slot
			const word = 0n;
			const betId = await placeAndFulfill(ctx, MIN_USDC_BET, 8, Risk.HIGH, word);
			const base = await plinko.getBetBase(betId);
			expect(Number(base.slotIndex)).to.equal(0);
			// 8-HIGH paytable[0] = 29e18 → payout = 29 * MIN_USDC_BET
			const expectedPayout = MIN_USDC_BET * 29n;
			expect(base.payout).to.equal(expectedPayout);
		});

		it('all-ones word → slot = rows (right edge)', async () => {
			const { plinko } = ctx;
			// All bits 1 → for 8 rows, low 8 bits = 0xFF → slot = 8
			const word = 0xffn;
			const betId = await placeAndFulfill(ctx, MIN_USDC_BET, 8, Risk.HIGH, word);
			const base = await plinko.getBetBase(betId);
			expect(Number(base.slotIndex)).to.equal(8);
			// 8-HIGH paytable[8] = 29e18
			expect(base.payout).to.equal(MIN_USDC_BET * 29n);
		});

		it('middle slot pays low multiplier (8-HIGH center → 0.2x)', async () => {
			const { plinko, usdc, player } = ctx;
			// 4 ones in 8 bits — e.g., 0x0F = 0b00001111. Popcount = 4 → slot 4
			const word = 0x0fn;
			const balBefore = await usdc.balanceOf(player.address);
			const betId = await placeAndFulfill(ctx, MIN_USDC_BET, 8, Risk.HIGH, word);
			const base = await plinko.getBetBase(betId);
			expect(Number(base.slotIndex)).to.equal(4);
			// 8-HIGH paytable[4] = 0.2e18 → payout = 0.2 * MIN_USDC_BET
			expect(base.payout).to.equal((MIN_USDC_BET * 2n) / 10n);
			// Net: -amount + 0.2*amount = -0.8*amount
			expect(await usdc.balanceOf(player.address)).to.equal(
				balBefore - MIN_USDC_BET + (MIN_USDC_BET * 2n) / 10n
			);
		});
	});

	describe('setPaytable', () => {
		it('owner can replace paytable; length must match rows + 1', async () => {
			const { plinko, owner } = ctx;
			const newPt = new Array(9).fill(0).map((_, i) => BigInt(i + 1) * ONE);
			await plinko.connect(owner).setPaytable(8, Risk.LOW, newPt);
			const pt = await plinko.getPaytable(8, Risk.LOW);
			expect(pt[0]).to.equal(ONE);
			expect(pt[8]).to.equal(9n * ONE);
			// max recomputed
			expect(await plinko.getMaxMultiplierE18(8, Risk.LOW)).to.equal(9n * ONE);
		});

		it('reverts on length mismatch', async () => {
			const { plinko, owner } = ctx;
			const bad = new Array(8).fill(ONE);
			await expect(
				plinko.connect(owner).setPaytable(8, Risk.LOW, bad)
			).to.be.revertedWithCustomError(plinko, 'PaytableLengthMismatch');
		});

		it('rejects non-owner / non-risk-manager', async () => {
			const { plinko, player } = ctx;
			const newPt = new Array(9).fill(ONE);
			await expect(plinko.connect(player).setPaytable(8, Risk.LOW, newPt)).to.be.reverted;
		});
	});

	describe('CasinoDataV2 — Plinko records', () => {
		it('returns full Plinko record after resolution', async () => {
			const { data, player } = ctx;
			const word = 0xaaaan;
			const betId = await placeAndFulfill(ctx, MIN_USDC_BET, 8, Risk.LOW, word);
			const r = await data.getPlinkoFullRecord(betId);
			expect(r.betId).to.equal(betId);
			expect(r.user).to.equal(player.address);
			expect(r.status).to.equal(BetStatus.RESOLVED);
			expect(Number(r.rows)).to.equal(8);
		});
	});

	describe('Cancel', () => {
		it('user cancel after timeout refunds amount', async () => {
			const { plinko, usdc, usdcAddr, player } = ctx;
			const balBefore = await usdc.balanceOf(player.address);
			const tx = await plinko
				.connect(player)
				.placeBet(usdcAddr, MIN_USDC_BET, 8, Risk.LOW, ethers.ZeroAddress);
			const receipt = await tx.wait();
			const placed = receipt.logs
				.map((l) => {
					try {
						return plinko.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			const betId = placed.args.betId;
			await time.increase(Number(CANCEL_TIMEOUT) + 1);
			await plinko.connect(player).cancelBet(betId);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore);
		});
	});
});
