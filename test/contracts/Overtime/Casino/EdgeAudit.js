// ============================================================================
// Casino Edge Audit — 10k-spin simulations to verify empirical RTP matches
// analytic house edge for each game.
//
// Run with: npx hardhat test test/contracts/Overtime/Casino/EdgeAudit.js
//
// Deterministic pseudo-random seeds (keccak of loop index) are used so runs
// are reproducible. Each test self-contained; failures in one game don't
// block the others.
// ============================================================================

const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const { upgrades, ethers } = require('hardhat');

const WETH_KEY = ethers.encodeBytes32String('WETH');
const OVER_KEY = ethers.encodeBytes32String('OVER');
const WETH_PRICE = ethers.parseEther('3000');
const OVER_PRICE = ethers.parseEther('1');

const MAX_PROFIT_USD = ethers.parseEther('1000'); // Per-bet profit cap
const CANCEL_TIMEOUT = 3600n;
const HOUSE_EDGE = ethers.parseEther('0.02'); // 2% (Dice, Slots)
const ONE = ethers.parseEther('1');

const BET_USDC = 3n * 1_000_000n; // 3 USDC minimum

// ============================================================================
// Shared token / manager / vrf fixture — returns a factory of a fresh Slots,
// Dice, Roulette, Baccarat, or Blackjack proxy on demand.
// ============================================================================
async function sharedFixture() {
	const [owner, player] = await ethers.getSigners();

	const ExoticUSDC = await ethers.getContractFactory('ExoticUSDC');
	const usdc = await ExoticUSDC.deploy();
	const usdcAddress = await usdc.getAddress();
	// Mint lots of USDC (each mintForUser gives 5000 USDC → 100 calls = 500k USDC total)
	for (let i = 0; i < 100; i++) await usdc.mintForUser(owner.address);

	const ExoticUSD = await ethers.getContractFactory('ExoticUSD');
	const weth = await ExoticUSD.deploy();
	const over = await ExoticUSD.deploy();
	const wethAddress = await weth.getAddress();
	const overAddress = await over.getAddress();

	const PriceFeed = await ethers.getContractFactory('MockPriceFeed');
	const priceFeed = await PriceFeed.deploy();
	await priceFeed.setPriceFeedForCollateral(WETH_KEY, wethAddress, WETH_PRICE);
	await priceFeed.setPriceFeedForCollateral(OVER_KEY, overAddress, OVER_PRICE);
	const priceFeedAddress = await priceFeed.getAddress();

	const SportsAMMV2Manager = await ethers.getContractFactory('SportsAMMV2Manager');
	const manager = await upgrades.deployProxy(SportsAMMV2Manager, [owner.address]);
	const managerAddress = await manager.getAddress();

	const MockVRFCoordinator = await ethers.getContractFactory('MockVRFCoordinator');
	const vrfCoordinator = await MockVRFCoordinator.deploy();
	const vrfCoordinatorAddress = await vrfCoordinator.getAddress();

	const core = {
		owner: owner.address,
		manager: managerAddress,
		priceFeed: priceFeedAddress,
		vrfCoordinator: vrfCoordinatorAddress,
	};
	const collateralConfig = {
		usdc: usdcAddress,
		weth: wethAddress,
		over: overAddress,
		wethPriceFeedKey: WETH_KEY,
		overPriceFeedKey: OVER_KEY,
	};
	const vrfConfig = {
		subscriptionId: 1,
		keyHash: ethers.ZeroHash,
		callbackGasLimit: 500000,
		requestConfirmations: 3,
		nativePayment: false,
	};

	return {
		owner,
		player,
		usdc,
		usdcAddress,
		weth,
		wethAddress,
		over,
		overAddress,
		vrfCoordinator,
		manager,
		core,
		collateralConfig,
		vrfConfig,
	};
}

// Utility: deterministic pseudo-random word from a loop index
function seedWord(i, salt = 0) {
	return BigInt(
		ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [i, salt]))
	);
}

// Utility: parse an event with a given name from a receipt
function parseEvent(contract, receipt, name) {
	for (const log of receipt.logs) {
		try {
			const parsed = contract.interface.parseLog(log);
			if (parsed?.name === name) return parsed;
		} catch {}
	}
	return null;
}

// ============================================================================
// DICE — 10k bets, ROLL_UNDER target=11 (50% hit, 1.96x payout, 2% edge)
// ============================================================================
describe('Edge Audit: Dice', () => {
	const NUM_BETS = 100000;
	const TARGET = 11; // ROLL_UNDER 11 → winning faces 1..10 → 50% win rate
	const BET_TYPE = 0; // ROLL_UNDER

	it(`should observe ~2% house edge over ${NUM_BETS} ROLL_UNDER bets`, async function () {
		this.timeout(9000000); // 150 min (100k iters)

		const f = await loadFixture(sharedFixture);
		const { owner, player, usdc, usdcAddress, vrfCoordinator, core, collateralConfig, vrfConfig } =
			f;

		const DiceFactory = await ethers.getContractFactory('Dice');
		const dice = await upgrades.deployProxy(DiceFactory, [], { initializer: false });
		const diceAddress = await dice.getAddress();
		await dice.initialize(
			core,
			collateralConfig,
			MAX_PROFIT_USD,
			CANCEL_TIMEOUT,
			HOUSE_EDGE,
			vrfConfig
		);

		// Large bankroll for variance
		await usdc.transfer(diceAddress, 50_000n * 1_000_000n);
		await usdc.transfer(player.address, 50_000n * 1_000_000n);

		await usdc.connect(player).approve(diceAddress, BET_USDC * BigInt(NUM_BETS));

		const playerBefore = await usdc.balanceOf(player.address);
		const houseBefore = await usdc.balanceOf(diceAddress);

		let wins = 0;
		for (let i = 1; i <= NUM_BETS; i++) {
			const tx = await dice
				.connect(player)
				.placeBet(usdcAddress, BET_USDC, BET_TYPE, TARGET, ethers.ZeroAddress);
			const receipt = await tx.wait();
			const placed = parseEvent(dice, receipt, 'BetPlaced');
			const requestId = placed.args.requestId;

			const word = seedWord(i, 1);
			await vrfCoordinator.fulfillRandomWords(diceAddress, requestId, [word]);

			// Result is word % 20 + 1, win if result < target (11)
			const result = Number(word % 20n) + 1;
			if (result < TARGET) wins++;
		}

		const playerAfter = await usdc.balanceOf(player.address);
		const houseAfter = await usdc.balanceOf(diceAddress);

		const totalWagered = BET_USDC * BigInt(NUM_BETS);
		const playerNet = playerAfter - playerBefore;
		const houseNet = houseAfter - houseBefore;
		const totalReturned = totalWagered + playerNet;

		const rtp = (Number(totalReturned) / Number(totalWagered)) * 100;
		const winRate = (wins / NUM_BETS) * 100;

		console.log('\n========== DICE EDGE AUDIT ==========');
		console.log(`Bets: ${NUM_BETS} | bet type: ROLL_UNDER | target: ${TARGET}`);
		console.log(`Wins: ${wins}/${NUM_BETS} (${winRate.toFixed(2)}% — expected 50.00%)`);
		console.log(`Total wagered:  ${(Number(totalWagered) / 1e6).toFixed(2)} USDC`);
		console.log(`Total returned: ${(Number(totalReturned) / 1e6).toFixed(2)} USDC`);
		console.log(
			`Player net:     ${playerNet >= 0n ? '+' : ''}${(Number(playerNet) / 1e6).toFixed(2)} USDC`
		);
		console.log(
			`House net:      ${houseNet >= 0n ? '+' : ''}${(Number(houseNet) / 1e6).toFixed(2)} USDC`
		);
		console.log(`Empirical RTP:  ${rtp.toFixed(2)}%  (expected 98.00%)`);
		console.log(`Empirical edge: ${(100 - rtp).toFixed(2)}%  (expected 2.00%)`);
		console.log('=====================================\n');

		expect(playerNet + houseNet).to.equal(0n);
		expect(rtp).to.be.within(96.0, 100.0); // ±2% tolerance
	});
});

// ============================================================================
// ROULETTE — 10k RED_BLACK bets on red (selection=0), expect 2.70% edge
// ============================================================================
describe('Edge Audit: Roulette', () => {
	const NUM_BETS = 100000;
	const BET_TYPE = 1; // RED_BLACK
	const SELECTION = 0; // red
	const RED_SET = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

	it(`should observe ~2.70% house edge over ${NUM_BETS} RED_BLACK bets`, async function () {
		this.timeout(9000000); // 150 min (100k iters)

		const f = await loadFixture(sharedFixture);
		const { owner, player, usdc, usdcAddress, vrfCoordinator, core, collateralConfig, vrfConfig } =
			f;

		const RouletteFactory = await ethers.getContractFactory('Roulette');
		const roulette = await upgrades.deployProxy(RouletteFactory, [], { initializer: false });
		const rouletteAddress = await roulette.getAddress();
		await roulette.initialize(core, collateralConfig, MAX_PROFIT_USD, CANCEL_TIMEOUT, vrfConfig);

		await usdc.transfer(rouletteAddress, 50_000n * 1_000_000n);
		await usdc.transfer(player.address, 50_000n * 1_000_000n);

		await usdc.connect(player).approve(rouletteAddress, BET_USDC * BigInt(NUM_BETS));

		const playerBefore = await usdc.balanceOf(player.address);
		const houseBefore = await usdc.balanceOf(rouletteAddress);

		let wins = 0;
		let zeroGreenCount = 0;
		for (let i = 1; i <= NUM_BETS; i++) {
			const tx = await roulette
				.connect(player)
				.placeBet(usdcAddress, BET_USDC, BET_TYPE, SELECTION, ethers.ZeroAddress);
			const receipt = await tx.wait();
			const placed = parseEvent(roulette, receipt, 'BetPlaced');
			const requestId = placed.args.requestId;

			const word = seedWord(i, 2);
			await vrfCoordinator.fulfillRandomWords(rouletteAddress, requestId, [word]);

			const result = Number(word % 37n);
			if (result === 0) zeroGreenCount++;
			if (RED_SET.has(result)) wins++;
		}

		const playerAfter = await usdc.balanceOf(player.address);
		const houseAfter = await usdc.balanceOf(rouletteAddress);

		const totalWagered = BET_USDC * BigInt(NUM_BETS);
		const playerNet = playerAfter - playerBefore;
		const totalReturned = totalWagered + playerNet;

		const rtp = (Number(totalReturned) / Number(totalWagered)) * 100;

		console.log('\n========== ROULETTE EDGE AUDIT ==========');
		console.log(`Bets: ${NUM_BETS} | bet type: RED_BLACK | selection: red`);
		console.log(
			`Wins:       ${wins}/${NUM_BETS} (${((wins / NUM_BETS) * 100).toFixed(2)}% — expected 48.65%)`
		);
		console.log(
			`Zero:       ${zeroGreenCount}/${NUM_BETS} (${((zeroGreenCount / NUM_BETS) * 100).toFixed(
				2
			)}% — expected 2.70%)`
		);
		console.log(`Player net: ${(Number(playerNet) / 1e6).toFixed(2)} USDC`);
		console.log(`Empirical RTP:  ${rtp.toFixed(2)}%  (expected 97.30%)`);
		console.log(`Empirical edge: ${(100 - rtp).toFixed(2)}%  (expected 2.70%)`);
		console.log('=========================================\n');

		expect(rtp).to.be.within(94.5, 100.0); // ±2.5% tolerance
	});

	it(`should observe ~2.70% house edge over ${NUM_BETS} STRAIGHT bets`, async function () {
		this.timeout(9000000); // 150 min (100k iters)

		const f = await loadFixture(sharedFixture);
		const { player, usdc, usdcAddress, vrfCoordinator, core, collateralConfig, vrfConfig } = f;

		const RouletteFactory = await ethers.getContractFactory('Roulette');
		const roulette = await upgrades.deployProxy(RouletteFactory, [], { initializer: false });
		const rouletteAddress = await roulette.getAddress();
		await roulette.initialize(core, collateralConfig, MAX_PROFIT_USD, CANCEL_TIMEOUT, vrfConfig);

		await usdc.transfer(rouletteAddress, 80_000n * 1_000_000n); // Extra for STRAIGHT variance
		await usdc.transfer(player.address, 50_000n * 1_000_000n);

		await usdc.connect(player).approve(rouletteAddress, BET_USDC * BigInt(NUM_BETS));

		const playerBefore = await usdc.balanceOf(player.address);

		const TARGET_NUMBER = 17;
		let wins = 0;
		for (let i = 1; i <= NUM_BETS; i++) {
			const tx = await roulette
				.connect(player)
				.placeBet(usdcAddress, BET_USDC, 0, TARGET_NUMBER, ethers.ZeroAddress); // 0 = STRAIGHT
			const receipt = await tx.wait();
			const placed = parseEvent(roulette, receipt, 'BetPlaced');
			const word = seedWord(i, 3);
			await vrfCoordinator.fulfillRandomWords(rouletteAddress, placed.args.requestId, [word]);

			const result = Number(word % 37n);
			if (result === TARGET_NUMBER) wins++;
		}

		const playerAfter = await usdc.balanceOf(player.address);
		const totalWagered = BET_USDC * BigInt(NUM_BETS);
		const playerNet = playerAfter - playerBefore;
		const totalReturned = totalWagered + playerNet;
		const rtp = (Number(totalReturned) / Number(totalWagered)) * 100;

		console.log('\n========== ROULETTE STRAIGHT AUDIT ==========');
		console.log(`Bets: ${NUM_BETS} | bet type: STRAIGHT | selection: ${TARGET_NUMBER}`);
		console.log(
			`Wins: ${wins}/${NUM_BETS} (${((wins / NUM_BETS) * 100).toFixed(2)}% — expected 2.70%)`
		);
		console.log(`Player net: ${(Number(playerNet) / 1e6).toFixed(2)} USDC`);
		console.log(`Empirical RTP:  ${rtp.toFixed(2)}%  (expected 97.30%)`);
		console.log(`Empirical edge: ${(100 - rtp).toFixed(2)}%  (expected 2.70%)`);
		console.log('=============================================\n');

		// STRAIGHT has high variance; wider tolerance
		expect(rtp).to.be.within(80.0, 110.0);
	});
});

// ============================================================================
// BACCARAT — 10k bets each for Player / Banker / Tie
// ============================================================================
describe('Edge Audit: Baccarat', () => {
	const NUM_BETS = 100000;

	// BetType enum
	const BetType = { PLAYER: 0, BANKER: 1, TIE: 2 };

	async function runBaccaratBets(betType, label, expectedRtp, tolerance) {
		const f = await loadFixture(sharedFixture);
		const { player, usdc, usdcAddress, vrfCoordinator, core, collateralConfig, vrfConfig } = f;

		const BaccaratFactory = await ethers.getContractFactory('Baccarat');
		const baccarat = await upgrades.deployProxy(BaccaratFactory, [], { initializer: false });
		const baccaratAddress = await baccarat.getAddress();
		await baccarat.initialize(
			core,
			collateralConfig,
			MAX_PROFIT_USD,
			CANCEL_TIMEOUT,
			0, // use DEFAULT_BANKER_PAYOUT (1.95x)
			vrfConfig
		);

		await usdc.transfer(baccaratAddress, 50_000n * 1_000_000n);
		await usdc.transfer(player.address, 50_000n * 1_000_000n);

		await usdc.connect(player).approve(baccaratAddress, BET_USDC * BigInt(NUM_BETS));

		const playerBefore = await usdc.balanceOf(player.address);

		let pWins = 0,
			bWins = 0,
			ties = 0;
		for (let i = 1; i <= NUM_BETS; i++) {
			const tx = await baccarat
				.connect(player)
				.placeBet(usdcAddress, BET_USDC, betType, ethers.ZeroAddress);
			const receipt = await tx.wait();
			const placed = parseEvent(baccarat, receipt, 'BetPlaced');
			const word = seedWord(i, 4);
			await vrfCoordinator.fulfillRandomWords(baccaratAddress, placed.args.requestId, [word]);

			// Classify the outcome via the off-chain mirror to get the aggregate distribution
			const outcome = simulateBaccarat(word);
			if (outcome === 'PLAYER') pWins++;
			else if (outcome === 'BANKER') bWins++;
			else ties++;
		}

		const playerAfter = await usdc.balanceOf(player.address);
		const totalWagered = BET_USDC * BigInt(NUM_BETS);
		const playerNet = playerAfter - playerBefore;
		const totalReturned = totalWagered + playerNet;
		const rtp = (Number(totalReturned) / Number(totalWagered)) * 100;

		console.log(`\n========== BACCARAT ${label} AUDIT ==========`);
		console.log(`Bets: ${NUM_BETS} | bet type: ${label}`);
		console.log(`  Player wins: ${pWins} (${((pWins / NUM_BETS) * 100).toFixed(2)}%)`);
		console.log(`  Banker wins: ${bWins} (${((bWins / NUM_BETS) * 100).toFixed(2)}%)`);
		console.log(`  Ties:        ${ties} (${((ties / NUM_BETS) * 100).toFixed(2)}%)`);
		console.log(`Player net:     ${(Number(playerNet) / 1e6).toFixed(2)} USDC`);
		console.log(`Empirical RTP:  ${rtp.toFixed(2)}%  (expected ~${expectedRtp.toFixed(2)}%)`);
		console.log(
			`Empirical edge: ${(100 - rtp).toFixed(2)}%  (expected ~${(100 - expectedRtp).toFixed(2)}%)`
		);
		console.log('================================================\n');

		expect(rtp).to.be.within(expectedRtp - tolerance, expectedRtp + tolerance);
	}

	// Off-chain mirror of contract card derivation + game logic
	function simulateBaccarat(word) {
		const getRank = (idx) => {
			const enc = ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [word, idx]);
			const h = BigInt(ethers.keccak256(enc));
			return Number((h % 13n) + 1n);
		};
		const cardVal = (rank) => {
			if (rank === 1) return 1;
			if (rank >= 2 && rank <= 9) return rank;
			return 0;
		};
		const p1 = cardVal(getRank(0));
		const b1 = cardVal(getRank(1));
		const p2 = cardVal(getRank(2));
		const b2 = cardVal(getRank(3));
		let pt = (p1 + p2) % 10;
		let bt = (b1 + b2) % 10;
		const pNat = pt === 8 || pt === 9;
		const bNat = bt === 8 || bt === 9;
		let p3 = 0;
		let pdrew = false;
		if (!pNat && !bNat) {
			pdrew = pt <= 5;
			if (pdrew) {
				p3 = cardVal(getRank(4));
				pt = (pt + p3) % 10;
			}
			let bdraw;
			if (!pdrew) bdraw = bt <= 5;
			else if (bt <= 2) bdraw = true;
			else if (bt === 3) bdraw = p3 !== 8;
			else if (bt === 4) bdraw = p3 >= 2 && p3 <= 7;
			else if (bt === 5) bdraw = p3 >= 4 && p3 <= 7;
			else if (bt === 6) bdraw = p3 === 6 || p3 === 7;
			else bdraw = false;
			if (bdraw) {
				const b3 = cardVal(getRank(5));
				bt = (bt + b3) % 10;
			}
		}
		if (pt > bt) return 'PLAYER';
		if (bt > pt) return 'BANKER';
		return 'TIE';
	}

	it(`should observe ~1.24% edge over ${NUM_BETS} PLAYER bets`, async function () {
		this.timeout(9000000); // 150 min (100k iters)
		await runBaccaratBets(BetType.PLAYER, 'PLAYER', 98.76, 2.0);
	});

	it(`should observe ~1.05% edge over ${NUM_BETS} BANKER bets (1.95x payout)`, async function () {
		this.timeout(9000000); // 150 min (100k iters)
		await runBaccaratBets(BetType.BANKER, 'BANKER', 98.95, 2.0);
	});

	it(`should observe ~14.36% edge over ${NUM_BETS} TIE bets (9x payout)`, async function () {
		this.timeout(9000000); // 150 min (100k iters)
		await runBaccaratBets(BetType.TIE, 'TIE', 85.64, 4.0);
	});
});

// ============================================================================
// SLOTS — 10k spins on the production pair+triple config
// ============================================================================
describe('Edge Audit: Slots', () => {
	const NUM_BETS = 100000;
	const NUM_SYMBOLS = 5;
	const SYMBOL_WEIGHTS = [34, 26, 18, 13, 9];
	const PAIR_PAYOUTS = [
		ethers.parseEther('0.5'),
		ethers.parseEther('0.75'),
		ethers.parseEther('1'),
		ethers.parseEther('1.25'),
		ethers.parseEther('1.75'),
	];
	const TRIPLE_PAYOUTS = [
		ethers.parseEther('2'),
		ethers.parseEther('4'),
		ethers.parseEther('10'),
		ethers.parseEther('20'),
		ethers.parseEther('38'),
	];
	const MAX_PAYOUT_MULTIPLIER = ethers.parseEther('50');

	function rollSymbol(word) {
		const total = SYMBOL_WEIGHTS.reduce((a, b) => a + b, 0);
		const rand = Number(word % BigInt(total));
		let acc = 0;
		for (let i = 0; i < NUM_SYMBOLS; i++) {
			acc += SYMBOL_WEIGHTS[i];
			if (rand < acc) return i;
		}
		return 0;
	}
	function deriveReels(randomWord) {
		const r = (i) =>
			BigInt(
				ethers.keccak256(
					ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [randomWord, i])
				)
			);
		return [rollSymbol(r(0)), rollSymbol(r(1)), rollSymbol(r(2))];
	}

	it(`should observe ~4.95% edge over ${NUM_BETS} spins`, async function () {
		this.timeout(12000000); // 200 min (100k iters)

		const f = await loadFixture(sharedFixture);
		const { player, usdc, usdcAddress, vrfCoordinator, core, collateralConfig, vrfConfig } = f;

		const SlotsFactory = await ethers.getContractFactory('Slots');
		const slots = await upgrades.deployProxy(SlotsFactory, [], { initializer: false });
		const slotsAddress = await slots.getAddress();
		await slots.initialize(
			core,
			collateralConfig,
			MAX_PROFIT_USD,
			CANCEL_TIMEOUT,
			HOUSE_EDGE,
			MAX_PAYOUT_MULTIPLIER,
			vrfConfig
		);
		await slots.setSymbols(NUM_SYMBOLS, SYMBOL_WEIGHTS);
		for (let i = 0; i < NUM_SYMBOLS; i++) {
			await slots.setPairPayout(i, PAIR_PAYOUTS[i]);
			await slots.setTriplePayout(i, TRIPLE_PAYOUTS[i]);
		}

		await usdc.transfer(slotsAddress, 50_000n * 1_000_000n);
		await usdc.transfer(player.address, 50_000n * 1_000_000n);

		await usdc.connect(player).approve(slotsAddress, BET_USDC * BigInt(NUM_BETS));

		const playerBefore = await usdc.balanceOf(player.address);

		let tripleWins = 0;
		let pairWins = 0;
		for (let i = 1; i <= NUM_BETS; i++) {
			const tx = await slots.connect(player).spin(usdcAddress, BET_USDC, ethers.ZeroAddress);
			const receipt = await tx.wait();
			const placed = parseEvent(slots, receipt, 'SpinPlaced');
			const word = seedWord(i, 5);
			await vrfCoordinator.fulfillRandomWords(slotsAddress, placed.args.requestId, [word]);

			const [a, b, c] = deriveReels(word);
			if (a === b && b === c) tripleWins++;
			else if (a === b || b === c) pairWins++;
		}

		const playerAfter = await usdc.balanceOf(player.address);
		const totalWagered = BET_USDC * BigInt(NUM_BETS);
		const playerNet = playerAfter - playerBefore;
		const totalReturned = totalWagered + playerNet;
		const rtp = (Number(totalReturned) / Number(totalWagered)) * 100;

		console.log('\n========== SLOTS EDGE AUDIT ==========');
		console.log(`Spins: ${NUM_BETS}`);
		console.log(
			`Pair wins:   ${pairWins} (${((pairWins / NUM_BETS) * 100).toFixed(2)}% — expected 34.99%)`
		);
		console.log(
			`Triple wins: ${tripleWins} (${((tripleWins / NUM_BETS) * 100).toFixed(2)}% — expected 6.56%)`
		);
		console.log(`Player net: ${(Number(playerNet) / 1e6).toFixed(2)} USDC`);
		console.log(`Empirical RTP:  ${rtp.toFixed(2)}%  (expected 95.05%)`);
		console.log(`Empirical edge: ${(100 - rtp).toFixed(2)}%  (expected 4.95%)`);
		console.log('=======================================\n');

		expect(rtp).to.be.within(92.0, 99.0); // ±3% tolerance (slots has higher variance due to max 38x payout)
	});
});

// ============================================================================
// BLACKJACK — 10k hands with mimic-dealer strategy
// (hit until hard ≥ 17 or soft ≥ 18, never double)
//
// Mimic-dealer on 3:2 S17 infinite deck has a published edge ~5.5%. This
// contract uses 3:2 BJ + H17 + no splits. Basic strategy drops edge to ~0.5%.
// This test uses mimic-dealer for simplicity — confirms house always has
// a clearly positive edge regardless of play style.
//
// Runtime note: each hand requires 2–3 transactions; 10k hands takes ~5 min.
// ============================================================================
describe('Edge Audit: Blackjack', () => {
	const NUM_HANDS = 100000;

	// Off-chain card derivation matching contract _deriveCard
	function deriveCard(word, shift) {
		const shifted = word >> (BigInt(shift) * 128n);
		return Number((shifted % 13n) + 1n);
	}
	function cardValue(rank) {
		if (rank === 1) return 11;
		if (rank >= 11) return 10;
		return rank;
	}
	// Mirror contract _calculateHandValue: sum as 11-aces, soft-adjust on bust
	function calcHandValue(cards) {
		let total = 0;
		let aces = 0;
		for (const r of cards) {
			if (r === 1) {
				aces++;
				total += 11;
			} else total += cardValue(r);
		}
		while (total > 21 && aces > 0) {
			total -= 10;
			aces--;
		}
		return { total, isSoft: aces > 0 };
	}
	// Mimic-dealer decision: hit until hard ≥ 17 or soft ≥ 18
	function playerDecision(cards) {
		const { total, isSoft } = calcHandValue(cards);
		if (total >= 21) return 'stand';
		if (isSoft) return total <= 17 ? 'hit' : 'stand';
		return total < 17 ? 'hit' : 'stand';
	}

	it(`should observe a positive house edge over ${NUM_HANDS} hands`, async function () {
		this.timeout(18000000); // 300 min (100k iters)

		const f = await loadFixture(sharedFixture);
		const { player, usdc, usdcAddress, vrfCoordinator, core, collateralConfig, vrfConfig } = f;

		const BjFactory = await ethers.getContractFactory('Blackjack');
		const bj = await upgrades.deployProxy(BjFactory, [], { initializer: false });
		const bjAddress = await bj.getAddress();
		await bj.initialize(core, collateralConfig, MAX_PROFIT_USD, CANCEL_TIMEOUT, vrfConfig);

		await usdc.transfer(bjAddress, 50_000n * 1_000_000n);
		await usdc.transfer(player.address, 50_000n * 1_000_000n);

		await usdc.connect(player).approve(bjAddress, BET_USDC * BigInt(NUM_HANDS * 3));

		const playerBefore = await usdc.balanceOf(player.address);

		const results = { blackjack: 0, win: 0, push: 0, loss: 0, bust: 0 };
		let hitCount = 0;
		let standCount = 0;

		for (let i = 1; i <= NUM_HANDS; i++) {
			// Place bet
			const placeTx = await bj.connect(player).placeBet(usdcAddress, BET_USDC, ethers.ZeroAddress);
			const placeReceipt = await placeTx.wait();
			const created = parseEvent(bj, placeReceipt, 'HandCreated');
			const handId = created.args.handId;
			const dealRequestId = created.args.requestId;

			// Fulfill deal — need TWO independent 256-bit words.
			// The contract derives cards from shift-0 and shift-128 of each word,
			// so using near-identical words would correlate player1/player2 and
			// dealerFaceUp/dealerHidden. Use two distinct seeds.
			const dealWord1 = seedWord(i, 6);
			const dealWord2 = seedWord(i, 66);
			await vrfCoordinator.fulfillRandomWords(bjAddress, dealRequestId, [dealWord1, dealWord2]);

			let details = await bj.getHandDetails(handId);
			if (details.status === 6n) {
				// Resolved immediately (dealt to PLAYER_BLACKJACK or DEALER_BLACKJACK)
				const r = Number(details.result);
				if (r === 1) results.blackjack++;
				else if (r === 3) results.loss++;
				else if (r === 4) results.push++;
				continue;
			}

			// Player turn loop
			let step = 0;
			while (details.status === 2n && step < 10) {
				const cards = await bj.getHandCards(handId);
				const playerCards = cards.playerCards.map((c) => Number(c));
				const decision = playerDecision(playerCards);

				if (decision === 'hit') {
					hitCount++;
					const hitTx = await bj.connect(player).hit(handId);
					const hitReceipt = await hitTx.wait();
					const hitEvent = parseEvent(bj, hitReceipt, 'HitRequested');
					const hitWord = seedWord(i * 100 + step, 7);
					await vrfCoordinator.fulfillRandomWords(bjAddress, hitEvent.args.requestId, [hitWord]);
				} else {
					standCount++;
					const standTx = await bj.connect(player).stand(handId);
					const standReceipt = await standTx.wait();
					const standEvent = parseEvent(bj, standReceipt, 'StandRequested');
					// Stand fulfillment needs 7 random words
					const standWords = [];
					for (let w = 0; w < 7; w++) standWords.push(seedWord(i * 100 + step * 10 + w, 8));
					await vrfCoordinator.fulfillRandomWords(bjAddress, standEvent.args.requestId, standWords);
					break;
				}

				details = await bj.getHandDetails(handId);
				step++;
			}

			const finalDetails = await bj.getHandDetails(handId);
			const r = Number(finalDetails.result);
			if (r === 1) results.blackjack++;
			else if (r === 2 || r === 6) results.win++;
			else if (r === 4) results.push++;
			else if (r === 5) results.bust++;
			else results.loss++;
		}

		const playerAfter = await usdc.balanceOf(player.address);
		const totalWagered = BET_USDC * BigInt(NUM_HANDS);
		const playerNet = playerAfter - playerBefore;
		const totalReturned = totalWagered + playerNet;
		const rtp = (Number(totalReturned) / Number(totalWagered)) * 100;

		console.log('\n========== BLACKJACK EDGE AUDIT ==========');
		console.log(
			`Hands: ${NUM_HANDS} | strategy: mimic-dealer (hit < hard 17 / soft 18, no double)`
		);
		console.log(`Player actions: ${hitCount} hits, ${standCount} stands`);
		console.log('Results:');
		console.log(
			`  Player blackjack (3:2): ${results.blackjack} (${(
				(results.blackjack / NUM_HANDS) *
				100
			).toFixed(2)}%)`
		);
		console.log(
			`  Player wins:            ${results.win} (${((results.win / NUM_HANDS) * 100).toFixed(2)}%)`
		);
		console.log(
			`  Push:                   ${results.push} (${((results.push / NUM_HANDS) * 100).toFixed(
				2
			)}%)`
		);
		console.log(
			`  Player bust:            ${results.bust} (${((results.bust / NUM_HANDS) * 100).toFixed(
				2
			)}%)`
		);
		console.log(
			`  Dealer wins:            ${results.loss} (${((results.loss / NUM_HANDS) * 100).toFixed(
				2
			)}%)`
		);
		console.log(`Total wagered: ${(Number(totalWagered) / 1e6).toFixed(2)} USDC`);
		console.log(`Player net:    ${(Number(playerNet) / 1e6).toFixed(2)} USDC`);
		console.log(`Empirical RTP:  ${rtp.toFixed(2)}% (expected ~94.5% with mimic-dealer)`);
		console.log(`Empirical edge: ${(100 - rtp).toFixed(2)}% (expected ~5.5% with mimic-dealer)`);
		console.log('==========================================\n');

		// With mimic-dealer strategy, empirical edge should be clearly positive for house
		expect(rtp).to.be.lessThan(100); // house must have edge
	});
});
