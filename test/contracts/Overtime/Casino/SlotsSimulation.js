const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const { upgrades, ethers } = require('hardhat');

// Production config mirror (scripts/deployContracts/deployCasino/deploySlots.js)
const WETH_KEY = ethers.encodeBytes32String('WETH');
const OVER_KEY = ethers.encodeBytes32String('OVER');
const WETH_PRICE = ethers.parseEther('3000');
const OVER_PRICE = ethers.parseEther('1');

const MAX_PROFIT_USD = ethers.parseEther('1000');
const CANCEL_TIMEOUT = 60n;
const HOUSE_EDGE = ethers.parseEther('0.02'); // 2%
const MAX_PAYOUT_MULTIPLIER = ethers.parseEther('50');
const ONE = ethers.parseEther('1');

const BET_AMOUNT = 3n * 1_000_000n; // 3 USDC
const NUM_SPINS = 1000;

// Production game math
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

// Analytic expectations (for the console banner)
const TOTAL_W = SYMBOL_WEIGHTS.reduce((a, b) => a + b, 0);
const P = SYMBOL_WEIGHTS.map((w) => w / TOTAL_W);
const EXPECTED_HIT_RATE = P.reduce((acc, p) => acc + (2 * p * p - p ** 3), 0); // 2Σp² - Σp³
const EXPECTED_TRIPLE_RATE = P.reduce((acc, p) => acc + p ** 3, 0);
const EXPECTED_PAIR_RATE = EXPECTED_HIT_RATE - EXPECTED_TRIPLE_RATE;

function computeExpectedRTP() {
	const houseEdgeNum = 0.02;
	let rtp = 0;
	for (let i = 0; i < NUM_SYMBOLS; i++) {
		const pairRaw = Number(ethers.formatEther(PAIR_PAYOUTS[i]));
		const tripleRaw = Number(ethers.formatEther(TRIPLE_PAYOUTS[i]));
		const pairProb = 2 * P[i] * P[i] * (1 - P[i]);
		const tripleProb = P[i] ** 3;
		rtp += pairProb * (1 + (1 - houseEdgeNum) * pairRaw);
		rtp += tripleProb * (1 + (1 - houseEdgeNum) * tripleRaw);
	}
	return rtp;
}
const EXPECTED_RTP = computeExpectedRTP();

async function deployFixture() {
	const [owner, player] = await ethers.getSigners();

	const ExoticUSDC = await ethers.getContractFactory('ExoticUSDC');
	const usdc = await ExoticUSDC.deploy();
	const usdcAddress = await usdc.getAddress();

	// Mint additional USDC so we can fund bankroll + player generously
	for (let i = 0; i < 5; i++) {
		await usdc.mintForUser(owner.address);
	}

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

	const SlotsFactory = await ethers.getContractFactory('Slots');
	const slots = await upgrades.deployProxy(SlotsFactory, [], { initializer: false });
	const slotsAddress = await slots.getAddress();

	await slots.initialize(
		{
			owner: owner.address,
			manager: managerAddress,
			priceFeed: priceFeedAddress,
			vrfCoordinator: vrfCoordinatorAddress,
		},
		{
			usdc: usdcAddress,
			weth: wethAddress,
			over: overAddress,
			wethPriceFeedKey: WETH_KEY,
			overPriceFeedKey: OVER_KEY,
		},
		MAX_PROFIT_USD,
		CANCEL_TIMEOUT,
		HOUSE_EDGE,
		MAX_PAYOUT_MULTIPLIER,
		{
			subscriptionId: 1,
			keyHash: ethers.ZeroHash,
			callbackGasLimit: 500000,
			requestConfirmations: 3,
			nativePayment: false,
		}
	);

	await slots.setSymbols(NUM_SYMBOLS, SYMBOL_WEIGHTS);
	for (let i = 0; i < NUM_SYMBOLS; i++) {
		await slots.setPairPayout(i, PAIR_PAYOUTS[i]);
		await slots.setTriplePayout(i, TRIPLE_PAYOUTS[i]);
	}

	// Fund bankroll and player generously for large-sample runs
	await usdc.transfer(slotsAddress, 15000n * 1_000_000n);
	await usdc.transfer(player.address, 10000n * 1_000_000n);

	return { slots, slotsAddress, usdc, usdcAddress, vrfCoordinator, owner, player };
}

// Mirror the contract's _roll logic off-chain to derive the reel without events
function rollSymbol(randomWord) {
	const total = SYMBOL_WEIGHTS.reduce((a, b) => a + b, 0);
	const rand = Number(randomWord % BigInt(total));
	let acc = 0;
	for (let i = 0; i < NUM_SYMBOLS; i++) {
		acc += SYMBOL_WEIGHTS[i];
		if (rand < acc) return i;
	}
	return 0;
}

function deriveReels(randomWord) {
	const r0 = BigInt(
		ethers.keccak256(
			ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [randomWord, 0])
		)
	);
	const r1 = BigInt(
		ethers.keccak256(
			ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [randomWord, 1])
		)
	);
	const r2 = BigInt(
		ethers.keccak256(
			ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [randomWord, 2])
		)
	);
	return [rollSymbol(r0), rollSymbol(r1), rollSymbol(r2)];
}

// Mirror of _getPayoutMultiplier: triple > adjacent pair > no win
function classify(reels) {
	const [a, b, c] = reels;
	if (a === b && b === c) return { kind: 'triple', symbol: a };
	if (a === b) return { kind: 'pair', symbol: a };
	if (b === c) return { kind: 'pair', symbol: b };
	return { kind: 'loss' };
}

describe('Slots Simulation', () => {
	let slots, slotsAddress, usdc, usdcAddress, vrfCoordinator, player;

	before(async () => {
		({ slots, slotsAddress, usdc, usdcAddress, vrfCoordinator, player } =
			await loadFixture(deployFixture));
	});

	it(`should run ${NUM_SPINS} spins and report the outcome`, async function () {
		this.timeout(600000); // 10 min — this is a lot of transactions

		await usdc.connect(player).approve(slotsAddress, BET_AMOUNT * BigInt(NUM_SPINS));

		const playerBalBefore = await usdc.balanceOf(player.address);
		const slotsBalBefore = await usdc.balanceOf(slotsAddress);

		let pairWins = 0;
		let tripleWins = 0;
		const pairWinsPerSymbol = new Array(NUM_SYMBOLS).fill(0);
		const tripleWinsPerSymbol = new Array(NUM_SYMBOLS).fill(0);
		const pairPayoutPerSymbol = new Array(NUM_SYMBOLS).fill(0n);
		const triplePayoutPerSymbol = new Array(NUM_SYMBOLS).fill(0n);
		let biggestWin = 0n;
		let currentLossStreak = 0;
		let longestLossStreak = 0;

		for (let i = 1; i <= NUM_SPINS; i++) {
			const tx = await slots.connect(player).spin(usdcAddress, BET_AMOUNT, ethers.ZeroAddress);
			const receipt = await tx.wait();

			let requestId;
			for (const log of receipt.logs) {
				try {
					const parsed = slots.interface.parseLog(log);
					if (parsed?.name === 'SpinPlaced') {
						requestId = parsed.args.requestId;
						break;
					}
				} catch {}
			}

			const randomWord = BigInt(
				ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [i]))
			);
			await vrfCoordinator.fulfillRandomWords(slotsAddress, requestId, [randomWord]);

			const reels = deriveReels(randomWord);
			const outcome = classify(reels);

			if (outcome.kind === 'triple') {
				tripleWins++;
				tripleWinsPerSymbol[outcome.symbol]++;
				const netMult = (TRIPLE_PAYOUTS[outcome.symbol] * (ONE - HOUSE_EDGE)) / ONE;
				const profit = (BET_AMOUNT * netMult) / ONE;
				const payout = BET_AMOUNT + profit;
				triplePayoutPerSymbol[outcome.symbol] += payout;
				if (payout > biggestWin) biggestWin = payout;
				currentLossStreak = 0;
			} else if (outcome.kind === 'pair') {
				pairWins++;
				pairWinsPerSymbol[outcome.symbol]++;
				const netMult = (PAIR_PAYOUTS[outcome.symbol] * (ONE - HOUSE_EDGE)) / ONE;
				const profit = (BET_AMOUNT * netMult) / ONE;
				const payout = BET_AMOUNT + profit;
				pairPayoutPerSymbol[outcome.symbol] += payout;
				if (payout > biggestWin) biggestWin = payout;
				currentLossStreak = 0;
			} else {
				currentLossStreak++;
				if (currentLossStreak > longestLossStreak) longestLossStreak = currentLossStreak;
			}
		}

		const playerBalAfter = await usdc.balanceOf(player.address);
		const slotsBalAfter = await usdc.balanceOf(slotsAddress);

		const totalStaked = BET_AMOUNT * BigInt(NUM_SPINS);
		const playerNet = playerBalAfter - playerBalBefore;
		const slotsNet = slotsBalAfter - slotsBalBefore;
		const totalReturned = totalStaked + playerNet;

		const totalWins = pairWins + tripleWins;
		const fmt = (v) => (Number(v) / 1e6).toFixed(2);
		const actualRTP = (Number(totalReturned) / Number(totalStaked)) * 100;

		console.log('\n========== SLOTS SIMULATION RESULTS ==========');
		console.log(`Spins:              ${NUM_SPINS}`);
		console.log(`Bet per spin:       ${fmt(BET_AMOUNT)} USDC`);
		console.log(`Total staked:       ${fmt(totalStaked)} USDC`);
		console.log('');
		console.log(
			`Total wins:         ${totalWins} (${((totalWins / NUM_SPINS) * 100).toFixed(2)}% — ` +
				`expected ${(EXPECTED_HIT_RATE * 100).toFixed(2)}%)`
		);
		console.log(
			`  Pair wins:        ${pairWins} (${((pairWins / NUM_SPINS) * 100).toFixed(2)}% — ` +
				`expected ${(EXPECTED_PAIR_RATE * 100).toFixed(2)}%)`
		);
		console.log(
			`  Triple wins:      ${tripleWins} (${((tripleWins / NUM_SPINS) * 100).toFixed(2)}% — ` +
				`expected ${(EXPECTED_TRIPLE_RATE * 100).toFixed(2)}%)`
		);
		console.log(`Losses:             ${NUM_SPINS - totalWins}`);
		console.log(`Longest loss streak: ${longestLossStreak}`);
		console.log(`Biggest single win: ${fmt(biggestWin)} USDC`);
		console.log('');
		console.log('Pair wins per symbol:');
		for (let i = 0; i < NUM_SYMBOLS; i++) {
			const rawMult = Number(ethers.formatEther(PAIR_PAYOUTS[i]));
			console.log(
				`  symbol ${i} (${rawMult}x): ${pairWinsPerSymbol[i].toString().padStart(4)} wins, ` +
					`${fmt(pairPayoutPerSymbol[i])} USDC returned`
			);
		}
		console.log('Triple wins per symbol:');
		for (let i = 0; i < NUM_SYMBOLS; i++) {
			const rawMult = Number(ethers.formatEther(TRIPLE_PAYOUTS[i]));
			console.log(
				`  symbol ${i} (${rawMult}x): ${tripleWinsPerSymbol[i].toString().padStart(4)} wins, ` +
					`${fmt(triplePayoutPerSymbol[i])} USDC returned`
			);
		}
		console.log('');
		console.log(`Total returned:     ${fmt(totalReturned)} USDC`);
		console.log(`Player net:         ${playerNet >= 0n ? '+' : ''}${fmt(playerNet)} USDC`);
		console.log(`House net:          ${slotsNet >= 0n ? '+' : ''}${fmt(slotsNet)} USDC`);
		console.log(
			`Actual RTP:         ${actualRTP.toFixed(2)}%  (target ${(EXPECTED_RTP * 100).toFixed(2)}%)`
		);
		console.log(`Effective edge:     ${(100 - actualRTP).toFixed(2)}%`);
		console.log('==============================================\n');

		// Sanity check — player balance changes should match sum of spin outcomes
		expect(playerNet + slotsNet).to.equal(0n);
	});
});
