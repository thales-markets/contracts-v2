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

const BetStatus = { NONE: 0, PENDING: 1, RESOLVED: 2, CANCELLED: 3 };
const Risk = { LOW: 0, MED: 1, HIGH: 2 };

function popcountLow8(word) {
	let bits = BigInt(word) & 0xffn;
	let c = 0;
	while (bits > 0n) {
		c += Number(bits & 1n);
		bits >>= 1n;
	}
	return c;
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

	const Plinko = await ethers.getContractFactory('Plinko');
	const plinko = await upgrades.deployProxy(Plinko, [], { initializer: false });
	const plinkoAddr = await plinko.getAddress();
	await plinko.initialize(owner.address, coreAddr, managerAddr);
	await core.registerGame(plinkoAddr);
	await core.setMaxNetLossPerGameUsd(plinkoAddr, ethers.parseEther('1000000'));

	const Data = await ethers.getContractFactory('CasinoDataV2');
	const data = await upgrades.deployProxy(Data, [], { initializer: false });
	await data.initialize(owner.address, coreAddr, ethers.ZeroAddress);
	await data.setPlinko(plinkoAddr);

	await usdc.mintForUser(owner.address);
	await usdc.transfer(coreAddr, 4_000n * USDC_UNIT);
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

async function placeAndFulfill(ctx, amount, risk, word) {
	const { plinko, vrf, coreAddr, usdcAddr, player } = ctx;
	const tx = await plinko.connect(player).placeBet(usdcAddr, amount, risk, ethers.ZeroAddress);
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

describe('CasinoCoreV2 + Plinko (8-row, single mode)', () => {
	let ctx;
	beforeEach(async () => {
		ctx = await loadFixture(deployFixture);
	});

	describe('Defaults', () => {
		it('sets default paytables for all 3 risk levels', async () => {
			const { plinko } = ctx;
			for (const risk of [Risk.LOW, Risk.MED, Risk.HIGH]) {
				const pt = await plinko.getPaytable(risk);
				expect(pt.length).to.equal(9);
				const max = await plinko.getMaxMultiplierE18(risk);
				expect(max).to.be.gt(0n);
			}
		});

		it('all default paytables clear ≥2% theoretical house edge', async () => {
			const { plinko } = ctx;
			const counts = [1, 8, 28, 56, 70, 56, 28, 8, 1];
			const total = 256n;
			for (const risk of [Risk.LOW, Risk.MED, Risk.HIGH]) {
				const pt = await plinko.getPaytable(risk);
				let weighted = 0n;
				for (let i = 0; i < pt.length; i++) {
					weighted += BigInt(counts[i]) * pt[i];
				}
				const evE18 = weighted / total;
				const heMicro = ((ONE - evE18) * 1_000_000n) / ONE;
				const hePercent = Number(heMicro) / 10_000;
				expect(hePercent, `risk=${risk} HE=${hePercent}%`).to.be.gte(2.0);
			}
		});
	});

	describe('placeBet', () => {
		it('reverts on zero amount', async () => {
			const { plinko, usdcAddr, player } = ctx;
			await expect(
				plinko.connect(player).placeBet(usdcAddr, 0n, Risk.LOW, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(plinko, 'InvalidAmount');
		});

		it('reverts on unsupported collateral', async () => {
			const { plinko, player } = ctx;
			const fake = ethers.Wallet.createRandom().address;
			await expect(
				plinko.connect(player).placeBet(fake, MIN_USDC_BET, Risk.LOW, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(plinko, 'InvalidCollateral');
		});

		it('reserves amount * maxMultiplier in core', async () => {
			const { plinko, plinkoAddr, core, usdc, usdcAddr, player } = ctx;
			const amount = MIN_USDC_BET;
			const balBefore = await usdc.balanceOf(player.address);
			await plinko.connect(player).placeBet(usdcAddr, amount, Risk.HIGH, ethers.ZeroAddress);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore - amount);
			const maxMult = await plinko.getMaxMultiplierE18(Risk.HIGH);
			const expectedReservation = (amount * maxMult) / ONE;
			expect(await core.reservedProfitPerGame(plinkoAddr, usdcAddr)).to.equal(expectedReservation);
		});
	});

	describe('VRF resolution', () => {
		it('slot derivation matches popcount(low 8 bits)', async () => {
			const { plinko } = ctx;
			// 0xAAAA → low 8 bits 0xAA → popcount = 4
			const word = 0xaaaan;
			const betId = await placeAndFulfill(ctx, MIN_USDC_BET, Risk.LOW, word);
			const base = await plinko.getBetBase(betId);
			expect(Number(base.slotIndex)).to.equal(popcountLow8(word));
			expect(base.status).to.equal(BetStatus.RESOLVED);
		});

		it('payout matches paytable lookup at slot index', async () => {
			const { plinko } = ctx;
			// All-zero word → slot 0
			const word = 0n;
			const betId = await placeAndFulfill(ctx, MIN_USDC_BET, Risk.HIGH, word);
			const base = await plinko.getBetBase(betId);
			expect(Number(base.slotIndex)).to.equal(0);
			// HIGH paytable[0] = 29x → payout = 29 * MIN_USDC_BET
			expect(base.payout).to.equal(MIN_USDC_BET * 29n);
		});

		it('all-ones low byte → slot = 8 (right edge)', async () => {
			const { plinko } = ctx;
			const word = 0xffn;
			const betId = await placeAndFulfill(ctx, MIN_USDC_BET, Risk.HIGH, word);
			const base = await plinko.getBetBase(betId);
			expect(Number(base.slotIndex)).to.equal(8);
			expect(base.payout).to.equal(MIN_USDC_BET * 29n);
		});

		it('middle slot pays low multiplier (HIGH center → 0.2x)', async () => {
			const { plinko, usdc, player } = ctx;
			// 0x0F = 0b00001111 → popcount = 4 → slot 4
			const word = 0x0fn;
			const balBefore = await usdc.balanceOf(player.address);
			const betId = await placeAndFulfill(ctx, MIN_USDC_BET, Risk.HIGH, word);
			const base = await plinko.getBetBase(betId);
			expect(Number(base.slotIndex)).to.equal(4);
			expect(base.payout).to.equal((MIN_USDC_BET * 2n) / 10n);
			expect(await usdc.balanceOf(player.address)).to.equal(
				balBefore - MIN_USDC_BET + (MIN_USDC_BET * 2n) / 10n
			);
		});
	});

	describe('setPaytable', () => {
		it('owner can replace paytable; length must equal 9', async () => {
			const { plinko, owner } = ctx;
			// Symmetric multipliers chosen to clear the 2% edge floor: weighted RTP with
			// binomial weights [1,8,28,56,70,56,28,8,1]/256 = 128/256 = 0.5 ≤ 0.98 ✓
			const newPt = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (BigInt(n) * ONE) / 10n);
			await plinko.connect(owner).setPaytable(Risk.LOW, newPt);
			const pt = await plinko.getPaytable(Risk.LOW);
			expect(pt[0]).to.equal(ONE / 10n);
			expect(pt[8]).to.equal((9n * ONE) / 10n);
			expect(await plinko.getMaxMultiplierE18(Risk.LOW)).to.equal((9n * ONE) / 10n);
		});

		it('reverts when paytable breaches the 2% edge floor', async () => {
			const { plinko, owner } = ctx;
			// All slots paying 1.0× → RTP = 256/256 = 1.0 > 0.98 → revert
			const bad = new Array(9).fill(ONE);
			await expect(plinko.connect(owner).setPaytable(Risk.LOW, bad)).to.be.revertedWithCustomError(
				plinko,
				'EdgeFloorBreached'
			);
		});

		it('reverts on length mismatch', async () => {
			const { plinko, owner } = ctx;
			const bad = new Array(8).fill(ONE);
			await expect(plinko.connect(owner).setPaytable(Risk.LOW, bad)).to.be.revertedWithCustomError(
				plinko,
				'PaytableLengthMismatch'
			);
		});

		it('rejects non-owner / non-risk-manager', async () => {
			const { plinko, player } = ctx;
			const newPt = new Array(9).fill(ONE);
			await expect(plinko.connect(player).setPaytable(Risk.LOW, newPt)).to.be.reverted;
		});
	});

	describe('CasinoDataV2 — Plinko records', () => {
		it('returns full Plinko record after resolution', async () => {
			const { data, player } = ctx;
			const word = 0xaaaan;
			const betId = await placeAndFulfill(ctx, MIN_USDC_BET, Risk.LOW, word);
			const r = await data.getPlinkoFullRecord(betId);
			expect(r.betId).to.equal(betId);
			expect(r.user).to.equal(player.address);
			expect(r.status).to.equal(BetStatus.RESOLVED);
			expect(Number(r.risk)).to.equal(Risk.LOW);
		});
	});

	describe('Cancel', () => {
		it('user cancel after timeout refunds amount', async () => {
			const { plinko, usdc, usdcAddr, player } = ctx;
			const balBefore = await usdc.balanceOf(player.address);
			const tx = await plinko
				.connect(player)
				.placeBet(usdcAddr, MIN_USDC_BET, Risk.LOW, ethers.ZeroAddress);
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

	describe('free bet (placeBetWithFreeBet)', () => {
		async function fundFB(ctx, amount) {
			const { fbh, fbhAddr, usdc, owner, player, usdcAddr } = ctx;
			await usdc.mintForUser(owner.address);
			await usdc.connect(owner).transfer(fbhAddr, amount);
			await fbh.setBalance(player.address, usdcAddr, amount);
		}

		async function placeFreeAndFulfill(ctx, amount, risk, word) {
			const { plinko, vrf, coreAddr, usdcAddr, player } = ctx;
			const tx = await plinko
				.connect(player)
				.placeBetWithFreeBet(usdcAddr, amount, risk, ethers.ZeroAddress);
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
			await vrf.fulfillRandomWords(coreAddr, placed.args.requestId, [word]);
			return placed.args.betId;
		}

		it('reverts when FBH balance < stake', async () => {
			const { plinko, usdcAddr, player } = ctx;
			await expect(
				plinko
					.connect(player)
					.placeBetWithFreeBet(usdcAddr, MIN_USDC_BET, Risk.LOW, ethers.ZeroAddress)
			).to.be.revertedWith('MockFBH: InsufficientBalance');
		});

		it('place-time: debits FBH, does NOT touch user wallet', async () => {
			const { plinko, fbh, usdc, usdcAddr, player } = ctx;
			await fundFB(ctx, MIN_USDC_BET);
			const balBefore = await usdc.balanceOf(player.address);
			await plinko
				.connect(player)
				.placeBetWithFreeBet(usdcAddr, MIN_USDC_BET, Risk.LOW, ethers.ZeroAddress);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore);
			expect(await fbh.balancePerUserAndCollateral(player.address, usdcAddr)).to.equal(0n);
		});

		it('win: stake → daoSink, profit → user wallet, no FBH credit back', async () => {
			const { fbh, usdc, usdcAddr, player, daoSink } = ctx;
			await fundFB(ctx, MIN_USDC_BET);
			// word 0 → slot 0 → HIGH paytable[0]=29x → big win
			const balBefore = await usdc.balanceOf(player.address);
			const daoBefore = await usdc.balanceOf(daoSink.address);
			await placeFreeAndFulfill(ctx, MIN_USDC_BET, Risk.HIGH, 0n);
			expect(await usdc.balanceOf(daoSink.address)).to.equal(daoBefore + MIN_USDC_BET);
			const profit = MIN_USDC_BET * 29n - MIN_USDC_BET;
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore + profit);
			expect(await fbh.balancePerUserAndCollateral(player.address, usdcAddr)).to.equal(0n);
		});

		it('partial loss (payout < stake): no referrer fee on free bets', async () => {
			const { fbh, usdc, usdcAddr, player } = ctx;
			await fundFB(ctx, MIN_USDC_BET);
			// HIGH paytable[4]=0.2x (popcount(0x0F)=4) → payout = 0.2 * stake
			const balBefore = await usdc.balanceOf(player.address);
			await placeFreeAndFulfill(ctx, MIN_USDC_BET, Risk.HIGH, 0x0fn);
			// confirmCasinoBetResolved called for the 0.2x payout (exercised <= stake → credit FBH)
			const expectedCredit = (MIN_USDC_BET * 2n) / 10n;
			expect(await fbh.balancePerUserAndCollateral(player.address, usdcAddr)).to.equal(
				expectedCredit
			);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore); // no profit went to wallet
			expect(await fbh.confirmCalls()).to.equal(1n);
		});

		it('cancel: stake refunded back to FBH balance (reusable)', async () => {
			const { plinko, fbh, usdc, usdcAddr, player } = ctx;
			await fundFB(ctx, MIN_USDC_BET);
			const tx = await plinko
				.connect(player)
				.placeBetWithFreeBet(usdcAddr, MIN_USDC_BET, Risk.LOW, ethers.ZeroAddress);
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
			await time.increase(Number(CANCEL_TIMEOUT) + 1);
			await plinko.connect(player).cancelBet(placed.args.betId);
			expect(await fbh.balancePerUserAndCollateral(player.address, usdcAddr)).to.equal(
				MIN_USDC_BET
			);
		});
	});

	describe('VRF callback edge paths', () => {
		it('onVrfFulfilled with unknown requestId is a silent no-op', async () => {
			const { plinko, coreAddr } = ctx;
			await ethers.provider.send('hardhat_impersonateAccount', [coreAddr]);
			await ethers.provider.send('hardhat_setBalance', [coreAddr, '0x56BC75E2D63100000']);
			const coreSigner = await ethers.getSigner(coreAddr);
			await expect(plinko.connect(coreSigner).onVrfFulfilled(99999999n, [0n])).to.not.be.reverted;
			await ethers.provider.send('hardhat_stopImpersonatingAccount', [coreAddr]);
		});
	});
});
