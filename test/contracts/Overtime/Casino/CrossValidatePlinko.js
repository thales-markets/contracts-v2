// ============================================================================
// Plinko Cross-Validation — places N real bets through MockVRFCoordinator and
// asserts per-bet that the contract's payout matches an INDEPENDENT off-chain
// model (computed via design-intent "for 1" semantics). Aggregates realized RTP
// and confirms convergence to analytic.
//
// This is the "VP bug detector" — if the contract drifts from design-intent
// payout math, the per-bet assertion fires immediately. Aggregate RTP gives
// statistical confidence on top.
//
// Default N: 10000 (set via env var: N_BETS=500 for smoke test). Excluded from
// default `npx hardhat test` run via EXCLUDED_EDGE_TESTS in hardhat.config.js.
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
const BET_AMOUNT = 3n * USDC_UNIT; // 3 USDC

const N_BETS = Number(process.env.N_BETS || 10000);
const PROGRESS_EVERY = 1000;
const Risk = { LOW: 0, MED: 1, HIGH: 2 };
const RISK_NAMES = ['LOW', 'MED', 'HIGH'];

function wordFromSeed(seed) {
	return BigInt('0x' + ethers.id(`plinko-xval-${seed}`).slice(2));
}

// Mirror contract's slot derivation (popcount of low 8 bits of VRF word)
function slotFromWord(word) {
	let bits = BigInt(word) & 0xffn;
	let c = 0;
	while (bits > 0n) {
		c += Number(bits & 1n);
		bits >>= 1n;
	}
	return c;
}

// Independent payout formula (design-intent "for 1" semantics):
// payout = stake × paytable[slot] / 1e18. No stake-back addition.
function expectedPayout(stakeBi, paytableBi, slot) {
	return (stakeBi * paytableBi[slot]) / ONE;
}

// Analytic RTP from paytable (binomial weights C(8,k)/256)
function analyticRTP(paytableBi) {
	const W = [1, 8, 28, 56, 70, 56, 28, 8, 1];
	let acc = 0n;
	for (let i = 0; i < 9; i++) acc += BigInt(W[i]) * paytableBi[i];
	return Number(acc) / 256 / 1e18;
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
	await core.setMaxNetLossPerGameUsd(plinkoAddr, ethers.parseEther('5000000'));

	// Fund: bankroll generously (10k bets × 3 USDC × ~5.6 max mult on LOW = ~$168k worst case;
	// we use $200k for safety) and the player wallet (10k × 3 = $30k wager + win float)
	await usdc.setDefaultAmount(1_000_000n * USDC_UNIT); // 1M USDC per mint
	await usdc.mintForUser(owner.address);
	await usdc.transfer(coreAddr, 200_000n * USDC_UNIT);
	await usdc.transfer(player.address, 100_000n * USDC_UNIT);
	await usdc.connect(player).approve(coreAddr, ethers.MaxUint256);

	return { plinko, plinkoAddr, vrf, core, coreAddr, usdc, usdcAddr, player };
}

describe('Plinko Cross-Validation: real on-chain', () => {
	it(`places ${N_BETS.toLocaleString(
		'en-US'
	)} bets and per-bet asserts contract == off-chain model`, async function () {
		this.timeout(60 * 60 * 1000); // up to 1h

		const ctx = await loadFixture(deployFixture);
		const { plinko, vrf, core, coreAddr, usdcAddr, player } = ctx;

		// Snapshot paytables off-chain once
		const paytables = {};
		for (const r of [Risk.LOW, Risk.MED, Risk.HIGH]) {
			const pt = await plinko.getPaytable(r);
			paytables[r] = pt.map((v) => BigInt(v));
		}

		// Sanity print
		for (const r of [Risk.LOW, Risk.MED, Risk.HIGH]) {
			const rtp = analyticRTP(paytables[r]);
			console.log(
				`Paytable ${RISK_NAMES[r].padEnd(4)}: analytic RTP ${(rtp * 100).toFixed(4)}%   (edge ${(
					(1 - rtp) *
					100
				).toFixed(4)}%)`
			);
		}

		// Stats
		const stats = {
			[Risk.LOW]: { totalStake: 0n, totalPayout: 0n, count: 0 },
			[Risk.MED]: { totalStake: 0n, totalPayout: 0n, count: 0 },
			[Risk.HIGH]: { totalStake: 0n, totalPayout: 0n, count: 0 },
		};
		const slotCounts = {
			[Risk.LOW]: new Array(9).fill(0),
			[Risk.MED]: new Array(9).fill(0),
			[Risk.HIGH]: new Array(9).fill(0),
		};

		const startTime = Date.now();

		for (let i = 0; i < N_BETS; i++) {
			const risk = i % 3; // cycle LOW / MED / HIGH evenly
			const word = wordFromSeed(`bet-${i}`);
			const expectedSlot = slotFromWord(word);
			const expectedMult = paytables[risk][expectedSlot];
			const expectedPay = expectedPayout(BET_AMOUNT, paytables[risk], expectedSlot);

			const tx = await plinko
				.connect(player)
				.placeBet(usdcAddr, BET_AMOUNT, risk, ethers.ZeroAddress);
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
			expect(placed, `BetPlaced not emitted at iter ${i}`).to.not.be.undefined;

			const betId = placed.args.betId;
			const requestId = placed.args.requestId;

			await vrf.fulfillRandomWords(coreAddr, requestId, [word]);

			const base = await plinko.getBetBase(betId);

			// PER-BET ASSERTIONS: catch any contract / off-chain model divergence
			expect(
				Number(base.slotIndex),
				`slotIndex mismatch at iter ${i} (risk=${RISK_NAMES[risk]})`
			).to.equal(expectedSlot);
			expect(base.multiplierE18, `multiplier mismatch at iter ${i}`).to.equal(expectedMult);
			expect(
				base.payout,
				`payout mismatch at iter ${i} (risk=${RISK_NAMES[risk]}, slot=${expectedSlot})`
			).to.equal(expectedPay);

			stats[risk].totalStake += BET_AMOUNT;
			stats[risk].totalPayout += base.payout;
			stats[risk].count++;
			slotCounts[risk][expectedSlot]++;

			if ((i + 1) % PROGRESS_EVERY === 0) {
				const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
				console.log(
					`  ${(i + 1).toString().padStart(6)}/${N_BETS}   ${elapsed}s elapsed   (~${(
						((i + 1) / N_BETS) *
						100
					).toFixed(1)}%)`
				);
			}
		}

		console.log('');
		console.log(`========== AGGREGATE RESULTS (${N_BETS} bets) ==========`);
		for (const r of [Risk.LOW, Risk.MED, Risk.HIGH]) {
			const s = stats[r];
			const realizedRtp = Number((s.totalPayout * 1_000_000n) / s.totalStake) / 1_000_000;
			const analytic = analyticRTP(paytables[r]);
			console.log(
				`${RISK_NAMES[r].padEnd(4)} (n=${s.count}):  realized RTP ${(realizedRtp * 100).toFixed(
					4
				)}%   analytic ${(analytic * 100).toFixed(4)}%   |Δ| ${(
					Math.abs(realizedRtp - analytic) * 100
				).toFixed(4)}pp`
			);
			// Slot distribution
			const slotLine = slotCounts[r].map((c, i) => `${i}:${c}`).join(' ');
			console.log(`  slots: ${slotLine}`);
		}

		// Aggregate sanity: realized RTP per risk should be within reasonable sampling tolerance.
		// Variance is driven by 5.6x / 13x / 29x corners — LOW/MED/HIGH have very different std devs.
		// Skip aggregate check for smoke-test sizes (N<1000) where per-risk sample is too small
		// to be statistically meaningful; per-bet assertions are the actual bug detector.
		if (N_BETS >= 1000) {
			const TOLERANCE_PP = N_BETS >= 10000 ? 0.04 : 0.08; // HIGH 29x tail needs wider band
			for (const r of [Risk.LOW, Risk.MED, Risk.HIGH]) {
				const s = stats[r];
				const realizedRtp = Number((s.totalPayout * 1_000_000n) / s.totalStake) / 1_000_000;
				const analytic = analyticRTP(paytables[r]);
				expect(
					Math.abs(realizedRtp - analytic),
					`${RISK_NAMES[r]} realized RTP ${realizedRtp.toFixed(4)} drifted >${(
						TOLERANCE_PP * 100
					).toFixed(1)}pp from analytic ${analytic.toFixed(4)}`
				).to.be.lessThan(TOLERANCE_PP);
			}
		} else {
			console.log(
				'(aggregate tolerance check skipped at N<1000 — per-bet assertions still active)'
			);
		}
	});
});
