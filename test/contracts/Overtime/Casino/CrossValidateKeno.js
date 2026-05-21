// ============================================================================
// Keno Cross-Validation — places N real bets through MockVRFCoordinator and
// asserts per-bet that the contract's draw mask, hits, and payout match an
// INDEPENDENT off-chain model (mirrors the contract's Fisher-Yates exactly
// for the DRAW math, but uses design-intent "for 1" semantics for PAYOUT).
//
// Default N: 1000 (set via env var). Excluded from default test run.
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

const N_BETS = Number(process.env.N_BETS || 1000);
const PROGRESS_EVERY = 200;

// Mirror Keno.sol constants
const POOL_SIZE = 80;
const DRAW_COUNT = 20;
const SHUFFLE_SHIFT_BITS = 16n;
const SHUFFLE_SHIFT_MASK = 0xffffn;
const CHUNKS_PER_WORD = 16;

function wordFromSeed(seed) {
	return BigInt('0x' + ethers.id(`keno-xval-${seed}`).slice(2));
}

// Mirror Keno.sol::_drawNumbers exactly — returns the 128-bit drawn mask
function drawMask(word) {
	const deck = new Uint8Array(POOL_SIZE);
	for (let i = 0; i < POOL_SIZE; i++) deck[i] = i + 1;
	let cursor = BigInt(word);
	let chunksLeft = CHUNKS_PER_WORD;
	for (let i = 0; i < DRAW_COUNT; i++) {
		if (chunksLeft === 0) {
			cursor = BigInt(
				ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [cursor]))
			);
			chunksLeft = CHUNKS_PER_WORD;
		}
		const remaining = BigInt(POOL_SIZE - i);
		const j = i + Number((cursor & SHUFFLE_SHIFT_MASK) % remaining);
		cursor >>= SHUFFLE_SHIFT_BITS;
		chunksLeft--;
		const tmp = deck[i];
		deck[i] = deck[j];
		deck[j] = tmp;
	}
	let mask = 0n;
	for (let i = 0; i < DRAW_COUNT; i++) mask |= 1n << BigInt(deck[i] - 1);
	return mask;
}

function picksToMask(picks) {
	let mask = 0n;
	for (const p of picks) mask |= 1n << BigInt(p - 1);
	return mask;
}

function popcount128(x) {
	let c = 0;
	while (x > 0n) {
		if (x & 1n) c++;
		x >>= 1n;
	}
	return c;
}

// Independent payout: stake × paytable[hits] (for 1 semantics)
function expectedPayout(stakeBi, paytableBi, hits) {
	return (stakeBi * paytableBi[hits]) / ONE;
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
	await core.setMaxNetLossPerGameUsd(kenoAddr, ethers.parseEther('5000000'));

	await usdc.setDefaultAmount(1_000_000n * USDC_UNIT);
	await usdc.mintForUser(owner.address);
	await usdc.transfer(coreAddr, 200_000n * USDC_UNIT);
	await usdc.transfer(player.address, 100_000n * USDC_UNIT);
	await usdc.connect(player).approve(coreAddr, ethers.MaxUint256);

	return { keno, kenoAddr, vrf, core, coreAddr, usdc, usdcAddr, player };
}

describe('Keno Cross-Validation: real on-chain', () => {
	it(`places ${N_BETS.toLocaleString(
		'en-US'
	)} bets and per-bet asserts contract == off-chain model`, async function () {
		this.timeout(60 * 60 * 1000);

		const ctx = await loadFixture(deployFixture);
		const { keno, vrf, core, coreAddr, usdcAddr, player } = ctx;

		// Snapshot paytables for picks 1..10
		const paytables = {};
		for (let n = 1; n <= 10; n++) {
			const pt = await keno.getPaytable(n);
			paytables[n] = pt.map((v) => BigInt(v));
		}

		const stats = {};
		for (let n = 1; n <= 10; n++) stats[n] = { totalStake: 0n, totalPayout: 0n, count: 0 };
		const startTime = Date.now();

		for (let i = 0; i < N_BETS; i++) {
			const picksCount = (i % 10) + 1; // cycle 1..10
			// Fixed picks: 1..picksCount (sorted, unique, in [1,80])
			const picks = [];
			for (let p = 1; p <= picksCount; p++) picks.push(p);
			const picksMask = picksToMask(picks);

			const word = wordFromSeed(`bet-${i}`);

			// Compute expected outcome OFF-CHAIN, before placing
			const expectedDrawnMask = drawMask(word);
			const expectedHits = popcount128(expectedDrawnMask & picksMask);
			const expectedMult = paytables[picksCount][expectedHits];
			const expectedPay = expectedPayout(BET_AMOUNT, paytables[picksCount], expectedHits);

			const tx = await keno
				.connect(player)
				.placeBet(usdcAddr, BET_AMOUNT, picks, ethers.ZeroAddress, false);
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
			expect(placed, `BetPlaced not emitted at iter ${i}`).to.not.be.undefined;

			const betId = placed.args.betId;
			const requestId = placed.args.requestId;

			await vrf.fulfillRandomWords(coreAddr, requestId, [word]);

			const base = await keno.getBetBase(betId);

			expect(BigInt(base.drawnMask), `drawn mask mismatch at iter ${i}`).to.equal(
				expectedDrawnMask
			);
			expect(Number(base.hits), `hits mismatch at iter ${i}`).to.equal(expectedHits);
			expect(base.multiplierE18, `mult mismatch at iter ${i}`).to.equal(expectedMult);
			expect(
				base.payout,
				`payout mismatch at iter ${i} (picks=${picksCount}, hits=${expectedHits})`
			).to.equal(expectedPay);

			stats[picksCount].totalStake += BET_AMOUNT;
			stats[picksCount].totalPayout += base.payout;
			stats[picksCount].count++;

			if ((i + 1) % PROGRESS_EVERY === 0) {
				const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
				console.log(
					`  ${(i + 1).toString().padStart(5)}/${N_BETS}   ${elapsed}s elapsed   (~${(
						((i + 1) / N_BETS) *
						100
					).toFixed(1)}%)`
				);
			}
		}

		console.log('');
		console.log(`========== AGGREGATE RESULTS (${N_BETS} bets) ==========`);
		console.log('pick  n    realized RTP   analytic   |Δ|');
		for (let n = 1; n <= 10; n++) {
			const s = stats[n];
			if (s.count === 0) continue;
			const realizedRtp = Number((s.totalPayout * 1_000_000n) / s.totalStake) / 1_000_000;
			// Analytic via hypergeometric — skipped here; per-bet exact match is the key invariant
			console.log(
				`  ${n.toString().padStart(2)}  ${s.count.toString().padStart(4)}   ${(
					realizedRtp * 100
				).toFixed(4)}%`
			);
		}
		console.log(
			'Per-bet drawn-mask & payout invariants all matched. Off-chain model and contract agree.'
		);
	});
});
