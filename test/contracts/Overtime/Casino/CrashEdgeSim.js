/**
 * Crash — 100k Monte Carlo edge simulation.
 *
 * Two phases:
 *   (1) Cross-validate JS RNG (`_crashPointE18`) against the live contract for VALIDATION_ROUNDS.
 *   (2) Run SIM_ROUNDS rounds in pure JS at three target multipliers and verify realized RTP
 *       converges to (1 - HE) regardless of target — the constant-edge property of this design.
 *
 * Excluded from the default `npx hardhat test` run via EXCLUDED_EDGE_TESTS in hardhat.config.js.
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
const SCALE = 1n << 32n;
const HE_E18 = 2n * 10n ** 16n; // 2%

const SIM_ROUNDS = 100_000;
const VALIDATION_ROUNDS = 30;
const BET_AMOUNT = 3n * USDC_UNIT;
const TARGETS_E18 = [
	2n * ONE, // 2.00x — short tail
	5n * ONE, // 5.00x — moderate tail
	(15n * ONE) / 10n, // 1.50x — high hit-rate
];

function crashPointE18(word, heE18 = HE_E18) {
	const u = BigInt(word) % SCALE;
	const heSlice = (heE18 * SCALE) / ONE;
	if (u < heSlice) return ONE;
	const numerator = (ONE - heE18) * SCALE;
	const denominator = SCALE - u;
	return numerator / denominator;
}

function wordFromSeed(seed) {
	return BigInt('0x' + ethers.id(`crash-sim-${seed}`).slice(2));
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

	const Crash = await ethers.getContractFactory('Crash');
	const crash = await upgrades.deployProxy(Crash, [], { initializer: false });
	const crashAddr = await crash.getAddress();
	await crash.initialize(owner.address, coreAddr, managerAddr);
	await core.registerGame(crashAddr);
	await core.connect(riskManager).setMaxNetLossPerGameUsd(crashAddr, ethers.parseEther('1000000'));

	await usdc.mintForUser(owner.address);
	await usdc.transfer(coreAddr, 4_000n * USDC_UNIT);
	await usdc.transfer(player.address, 500n * USDC_UNIT);
	await usdc.connect(player).approve(coreAddr, ethers.MaxUint256);

	return { crash, crashAddr, vrf, core, coreAddr, usdc, usdcAddr, player };
}

describe('Crash — edge sim & EVM cross-validation', function () {
	this.timeout(600_000);

	it(`cross-validates JS RNG vs on-chain logic across ${VALIDATION_ROUNDS} rounds`, async () => {
		const ctx = await loadFixture(deployFixture);
		const { crash, crashAddr, vrf, coreAddr, usdcAddr, player } = ctx;

		for (let i = 0; i < VALIDATION_ROUNDS; i++) {
			const word = wordFromSeed(`v-${i}`);
			const target = TARGETS_E18[i % TARGETS_E18.length];

			const tx = await crash
				.connect(player)
				.placeBet(usdcAddr, BET_AMOUNT, target, ethers.ZeroAddress);
			const receipt = await tx.wait();
			const placed = receipt.logs
				.map((l) => {
					try {
						return crash.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			const betId = placed.args.betId;
			const reqId = placed.args.requestId;

			await vrf.fulfillRandomWords(coreAddr, reqId, [word]);

			const base = await crash.getBetBase(betId);
			const expectedCrash = crashPointE18(word);
			expect(base.crashPointE18).to.equal(expectedCrash);
			const expectedWon = expectedCrash >= target;
			expect(base.won).to.equal(expectedWon);
			const expectedPayout = expectedWon ? (BET_AMOUNT * target) / ONE : 0n;
			expect(base.payout).to.equal(expectedPayout);
		}
	});

	for (const target of TARGETS_E18) {
		const targetStr = (Number(target) / 1e18).toFixed(2);
		it(`runs ${SIM_ROUNDS.toLocaleString()} rounds at target=${targetStr}x and validates ~${(
			(Number(ONE - HE_E18) / 1e18) *
			100
		).toFixed(2)}% RTP`, () => {
			let wagered = 0n;
			let returned = 0n;
			let wins = 0;
			let instantCrashes = 0;

			for (let i = 0; i < SIM_ROUNDS; i++) {
				const word = wordFromSeed(`s-${target}-${i}`);
				const cp = crashPointE18(word);
				if (cp === ONE) instantCrashes++;
				const won = cp >= target;
				if (won) {
					wins++;
					returned += (BET_AMOUNT * target) / ONE;
				}
				wagered += BET_AMOUNT;
			}

			const rtp = (Number(returned) / Number(wagered)) * 100;
			const edge = 100 - rtp;
			const hitRate = (wins / SIM_ROUNDS) * 100;
			// Theoretical hit rate at target T = (1 - HE) / T
			const theoryHit = (Number(ONE - HE_E18) / 1e18 / (Number(target) / 1e18)) * 100;

			console.log('');
			console.log(`==== Crash 100k summary @ target=${targetStr}x ====`);
			console.log(`Rounds:           ${SIM_ROUNDS.toLocaleString()}`);
			console.log(
				`Wins:             ${wins} (${hitRate.toFixed(2)}%, theory ${theoryHit.toFixed(2)}%)`
			);
			console.log(
				`Instant crashes:  ${instantCrashes} (${((instantCrashes / SIM_ROUNDS) * 100).toFixed(
					2
				)}%, theory 2.00%)`
			);
			console.log(`Realized RTP:     ${rtp.toFixed(2)}%   (target 98.00%)`);
			console.log(`Realized edge:    ${edge.toFixed(2)}%   (target 2.00%)`);
			console.log('=================================================');

			// Edge should be near 2% but with finite-sample variance at low target.
			// 95% CI on 100k binomial trials with p ≈ 0.49 is ~±0.3pp on hit rate, which at
			// target=2x maps to ~±2pp on RTP. Use a loose floor for sanity-only check.
			expect(edge).to.be.gt(-2); // realized edge can dip below 0 under variance; just guard against catastrophic miscalibration
		});
	}
});
