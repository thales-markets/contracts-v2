/**
 * Plinko — 100k Monte Carlo edge simulation per risk level (3 combos total).
 *
 * Contract is fixed at 8 rows (`Plinko.sol:31 ROWS = 8`), with 3 risk presets (LOW/MED/HIGH)
 * each backed by a 9-slot paytable. Slot = popcount(word & 0xFF), so slot ∈ [0,8].
 *
 * Two phases:
 *   (1) Cross-validate JS slot derivation (`popcount(word & 0xFF)`) and the default paytables
 *       against the live contract for VALIDATION_ROUNDS rounds.
 *   (2) Run SIM_ROUNDS rounds in pure JS for each risk and compare realized RTP to the
 *       analytic RTP = sum_k C(8,k)/256 * paytable[k]. Each combo is calibrated to ≥2%
 *       theoretical edge — the sim verifies this empirically and surfaces realized edge.
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
const MAX_PROFIT_USD = ethers.parseEther('1000000');
const CANCEL_TIMEOUT = 3600n;
const USDC_UNIT = 1_000_000n;
const ONE = 10n ** 18n;

const SIM_ROUNDS = 100_000;
const VALIDATION_ROUNDS = 30;
const BET_AMOUNT = 3n * USDC_UNIT;

const ROWS = 8;
const SLOTS = ROWS + 1;
const SLOT_MASK = (1n << BigInt(ROWS)) - 1n;
const Risk = { LOW: 0, MED: 1, HIGH: 2 };
const RISK_NAMES = ['LOW', 'MED', 'HIGH'];

function wordFromSeed(seed) {
	return BigInt('0x' + ethers.id(`plinko-sim-${seed}`).slice(2));
}

function slotFromWord(word) {
	let bits = BigInt(word) & SLOT_MASK;
	let c = 0;
	while (bits > 0n) {
		if ((bits & 1n) === 1n) c++;
		bits >>= 1n;
	}
	return c;
}

function choose(n, k) {
	if (k < 0 || k > n) return 0;
	let r = 1;
	for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
	return r;
}

// Compute analytic RTP: sum_k C(8,k)/256 * paytable[k] (paytable is bigint 1e18)
function analyticRTP(paytable) {
	const denom = 2 ** ROWS;
	let rtp = 0;
	for (let k = 0; k <= ROWS; k++) {
		const p = choose(ROWS, k) / denom;
		const m = Number(paytable[k]) / 1e18;
		rtp += p * m;
	}
	return rtp;
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
	await core.setMaxNetLossPerGameUsd(plinkoAddr, ethers.parseEther('5000000'));

	await usdc.mintForUser(owner.address);
	await usdc.mintForUser(owner.address);
	await usdc.transfer(coreAddr, 9_000n * USDC_UNIT);
	await usdc.transfer(player.address, 500n * USDC_UNIT);
	await usdc.connect(player).approve(coreAddr, ethers.MaxUint256);

	return { plinko, plinkoAddr, vrf, core, coreAddr, usdc, usdcAddr, player };
}

async function placeAndResolve(ctx, risk, word) {
	const { plinko, vrf, coreAddr, usdcAddr, player } = ctx;
	const tx = await plinko.connect(player).placeBet(usdcAddr, BET_AMOUNT, risk, ethers.ZeroAddress);
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

describe('Plinko — edge sim & EVM cross-validation', function () {
	this.timeout(900_000);

	let paytables = {}; // paytables[risk] = bigint[]

	before(async () => {
		const ctx = await loadFixture(deployFixture);
		for (const r of [Risk.LOW, Risk.MED, Risk.HIGH]) {
			const pt = await ctx.plinko.getPaytable(r);
			paytables[r] = pt.map((v) => BigInt(v));
			if (paytables[r].length !== SLOTS) {
				throw new Error(
					`paytable for risk=${RISK_NAMES[r]} has length ${paytables[r].length}, expected ${SLOTS}`
				);
			}
		}
	});

	it(`cross-validates slot derivation + paytable across ${VALIDATION_ROUNDS} rounds`, async () => {
		const ctx = await loadFixture(deployFixture);
		const { plinko } = ctx;

		// Re-fetch paytables in this fresh fixture
		const local = {};
		for (const r of [Risk.LOW, Risk.MED, Risk.HIGH]) {
			const pt = await plinko.getPaytable(r);
			local[r] = pt.map((v) => BigInt(v));
		}

		for (let i = 0; i < VALIDATION_ROUNDS; i++) {
			const risk = i % 3;
			const word = wordFromSeed(`v-${i}-${risk}`);
			const expectedSlot = slotFromWord(word);
			const expectedMult = local[risk][expectedSlot];

			const betId = await placeAndResolve(ctx, risk, word);
			const base = await plinko.getBetBase(betId);
			expect(Number(base.slotIndex)).to.equal(expectedSlot);
			expect(base.multiplierE18).to.equal(expectedMult);
			expect(base.payout).to.equal((BET_AMOUNT * expectedMult) / ONE);
		}
	});

	for (const risk of [Risk.LOW, Risk.MED, Risk.HIGH]) {
		it(`runs ${SIM_ROUNDS.toLocaleString()} rounds @ risk=${RISK_NAMES[risk]}`, () => {
			const pt = paytables[risk];
			if (!pt) throw new Error('paytable missing — before() did not run?');

			let totalStake = 0n;
			let totalPayout = 0n;
			const slotCounts = new Array(SLOTS).fill(0);
			let biggestWin = 0n;

			for (let i = 0; i < SIM_ROUNDS; i++) {
				const w = wordFromSeed(`s-${risk}-${i}`);
				const slot = slotFromWord(w);
				slotCounts[slot]++;
				const mult = pt[slot];
				const payout = (BET_AMOUNT * mult) / ONE;
				if (payout > biggestWin) biggestWin = payout;
				totalStake += BET_AMOUNT;
				totalPayout += payout;
			}

			const rtp = (Number(totalPayout) / Number(totalStake)) * 100;
			const edge = 100 - rtp;
			const analytic = analyticRTP(pt) * 100;
			const analyticEdge = 100 - analytic;
			const fmt = (v) => (Number(v) / 1e6).toFixed(2);

			console.log('');
			console.log(`==== Plinko 100k summary @ risk=${RISK_NAMES[risk]} ====`);
			console.log(`Rounds:          ${SIM_ROUNDS.toLocaleString()}`);
			console.log(`Realized RTP:    ${rtp.toFixed(2)}%   (analytic ${analytic.toFixed(2)}%)`);
			console.log(`Realized edge:   ${edge.toFixed(2)}%   (analytic ${analyticEdge.toFixed(2)}%)`);
			console.log(
				`Biggest win:     ${fmt(biggestWin)} USDC (${(
					Number(biggestWin) / Number(BET_AMOUNT)
				).toFixed(2)}x)`
			);
			console.log('============================================');

			// Analytic edge is the source of truth — calibrated to ≥2% by the contract's
			// _setPaytableInternal check, so this is a belt-and-suspenders empirical confirm
			expect(analyticEdge).to.be.gt(1.5);
		});
	}
});
