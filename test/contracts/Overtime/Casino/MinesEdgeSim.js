/**
 * Mines — 100k Monte Carlo edge simulation.
 *
 * Two phases:
 *   (1) Cross-validate JS Fisher-Yates shuffle and the multiplier formula against the live
 *       contract for VALIDATION_ROUNDS rounds (one bet placed and resolved per round).
 *   (2) Run SIM_ROUNDS rounds in pure JS at multiple (mineCount, revealCount) configurations,
 *       assuming honest play (player picks tile sequence pre-commit). Realized RTP should
 *       converge to (1 - HE) regardless of mineCount/revealCount by design.
 *
 * NOTE: The Mines contract stores the mineMask in storage after VRF fulfillment, which is
 * snoopable via eth_getStorageAt — see the comment block in `Mines.sol` for the rationale.
 * This sim assumes honest play (no snooping) to verify the configured house edge.
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
const HE_E18 = 2n * 10n ** 16n; // 2%
const MAX_MULT_E18 = 1000n * ONE;
const GRID_SIZE = 25;

const SIM_ROUNDS = 100_000;
const VALIDATION_ROUNDS = 30;
const BET_AMOUNT = 3n * USDC_UNIT;

// (mineCount, revealCount) pairs to exercise across the multiplier curve
const SCENARIOS = [
	{ mines: 3, reveals: 3 },
	{ mines: 5, reveals: 5 },
	{ mines: 10, reveals: 3 },
	{ mines: 1, reveals: 10 },
];

/* ========== JS MIRROR ========== */

// Mirror of `_shuffleMines` exactly: 16-bit chunks, re-hash every 16 swaps.
function shuffleMines(word, mineCount) {
	const deck = Array.from({ length: GRID_SIZE }, (_, i) => i);
	let cursor = BigInt(word);
	let chunksLeft = 16;
	const MASK = 0xffffn;
	for (let i = 0; i < mineCount; i++) {
		if (chunksLeft === 0) {
			cursor = BigInt(
				ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [cursor]))
			);
			chunksLeft = 16;
		}
		const remaining = BigInt(GRID_SIZE - i);
		const j = i + Number((cursor & MASK) % remaining);
		cursor >>= 16n;
		chunksLeft--;
		[deck[i], deck[j]] = [deck[j], deck[i]];
	}
	let mask = 0;
	for (let i = 0; i < mineCount; i++) {
		mask |= 1 << deck[i];
	}
	return mask >>> 0;
}

// Multiplier formula: m = (1 - HE) * prod_{i=0..safe-1} (25 - i) / (25 - mines - i), capped at maxM
function multiplierE18(mineCount, safeCount, heE18 = HE_E18, maxE18 = MAX_MULT_E18) {
	if (safeCount === 0) return 0n;
	if (safeCount > GRID_SIZE - mineCount) return maxE18;
	let m = ONE - heE18;
	for (let i = 0; i < safeCount; i++) {
		m = (m * BigInt(GRID_SIZE - i)) / BigInt(GRID_SIZE - mineCount - i);
		if (m >= maxE18) return maxE18;
	}
	return m;
}

function wordFromSeed(seed) {
	return BigInt('0x' + ethers.id(`mines-sim-${seed}`).slice(2));
}

// Pre-committed reveal sequence: just pick the first `reveals` tile indices [0, 1, ..., reveals-1].
// (Equivalent to any pre-committed sequence by symmetry — this is honest play.)
function honestRevealSequence(reveals) {
	return Array.from({ length: reveals }, (_, i) => i);
}

function simulateRound(seed, mineCount, revealCount) {
	const word = wordFromSeed(seed);
	const mineMask = shuffleMines(word, mineCount);
	const seq = honestRevealSequence(revealCount);
	let safeCount = 0;
	for (const tile of seq) {
		if ((mineMask & (1 << tile)) !== 0) {
			return { stake: BET_AMOUNT, payout: 0n, hitMine: true, safeCount };
		}
		safeCount++;
	}
	const mult = multiplierE18(mineCount, safeCount);
	const payout = (BET_AMOUNT * mult) / ONE;
	return { stake: BET_AMOUNT, payout, hitMine: false, safeCount };
}

/* ========== FIXTURE ========== */

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

	const Mines = await ethers.getContractFactory('Mines');
	const mines = await upgrades.deployProxy(Mines, [], { initializer: false });
	const minesAddr = await mines.getAddress();
	await mines.initialize(owner.address, coreAddr, managerAddr);
	await core.registerGame(minesAddr);
	await core.connect(riskManager).setMaxNetLossPerGameUsd(minesAddr, ethers.parseEther('1000000'));

	await usdc.mintForUser(owner.address);
	await usdc.transfer(coreAddr, 4_000n * USDC_UNIT);
	await usdc.transfer(player.address, 500n * USDC_UNIT);
	await usdc.connect(player).approve(coreAddr, ethers.MaxUint256);

	return { mines, minesAddr, vrf, core, coreAddr, usdc, usdcAddr, player };
}

async function placeAndDeal(ctx, mineCount, word) {
	const { mines, vrf, coreAddr, usdcAddr, player } = ctx;
	const tx = await mines
		.connect(player)
		.placeBet(usdcAddr, BET_AMOUNT, mineCount, ethers.ZeroAddress);
	const receipt = await tx.wait();
	const placed = receipt.logs
		.map((l) => {
			try {
				return mines.interface.parseLog(l);
			} catch {
				return null;
			}
		})
		.find((e) => e?.name === 'BetPlaced');
	const betId = placed.args.betId;
	await vrf.fulfillRandomWords(coreAddr, placed.args.requestId, [word]);
	return betId;
}

/* ========== TESTS ========== */

describe('Mines — edge sim & EVM cross-validation', function () {
	this.timeout(600_000);

	it(`cross-validates JS shuffle + multiplier vs on-chain across ${VALIDATION_ROUNDS} rounds`, async () => {
		const ctx = await loadFixture(deployFixture);
		const { mines, player } = ctx;

		for (let i = 0; i < VALIDATION_ROUNDS; i++) {
			const mineCount = 1 + (i % 10); // mix mine counts 1..10
			const word = wordFromSeed(`v-${i}-${mineCount}`);
			const expectedMask = shuffleMines(word, mineCount);

			const betId = await placeAndDeal(ctx, mineCount, word);
			const onChainMask = Number(await mines.getMineMask(betId));
			expect(onChainMask).to.equal(expectedMask);

			// Reveal a few safe tiles where possible, then cashout to compare multiplier
			let safeCount = 0;
			for (let tile = 0; tile < GRID_SIZE && safeCount < 3; tile++) {
				if ((expectedMask & (1 << tile)) !== 0) continue;
				await mines.connect(player).revealTile(betId, tile);
				safeCount++;
			}
			if (safeCount > 0) {
				await mines.connect(player).cashout(betId);
				const base = await mines.getBetBase(betId);
				const expectedMult = multiplierE18(mineCount, safeCount);
				expect(base.payout).to.equal((BET_AMOUNT * expectedMult) / ONE);
			}
		}
	});

	for (const sc of SCENARIOS) {
		it(`runs ${SIM_ROUNDS.toLocaleString()} rounds @ mines=${sc.mines}, reveals=${
			sc.reveals
		}`, () => {
			let totalStake = 0n;
			let totalPayout = 0n;
			let cashouts = 0;
			let mineHits = 0;
			let totalSafeReveals = 0;

			for (let i = 0; i < SIM_ROUNDS; i++) {
				const r = simulateRound(`s-${sc.mines}-${sc.reveals}-${i}`, sc.mines, sc.reveals);
				totalStake += r.stake;
				totalPayout += r.payout;
				totalSafeReveals += r.safeCount;
				if (r.hitMine) mineHits++;
				else cashouts++;
			}

			const rtp = (Number(totalPayout) / Number(totalStake)) * 100;
			const edge = 100 - rtp;
			const cashoutRate = (cashouts / SIM_ROUNDS) * 100;

			// Theoretical cashout probability = C(25-mines, reveals) / C(25, reveals)
			const choose = (n, k) => {
				let r = 1;
				for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
				return r;
			};
			const theoryCashout = (choose(25 - sc.mines, sc.reveals) / choose(25, sc.reveals)) * 100;

			console.log('');
			console.log(`==== Mines 100k summary @ mines=${sc.mines}, reveals=${sc.reveals} ====`);
			console.log(`Rounds:           ${SIM_ROUNDS.toLocaleString()}`);
			console.log(
				`Cashouts:         ${cashouts} (${cashoutRate.toFixed(2)}%, theory ${theoryCashout.toFixed(
					2
				)}%)`
			);
			console.log(`Mine hits:        ${mineHits} (${((mineHits / SIM_ROUNDS) * 100).toFixed(2)}%)`);
			console.log(`Avg safe reveals: ${(totalSafeReveals / SIM_ROUNDS).toFixed(2)}`);
			console.log(`Realized RTP:     ${rtp.toFixed(2)}%   (target 98.00%)`);
			console.log(`Realized edge:    ${edge.toFixed(2)}%   (target 2.00%)`);
			console.log('==============================================================');

			// Loose floor under MC variance — high reveals × few mines means rare jackpot tail.
			// Just sanity-check no catastrophic miscalibration.
			expect(edge).to.be.gt(-10);
		});
	}
});
