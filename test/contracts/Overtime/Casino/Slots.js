const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const { upgrades, ethers } = require('hardhat');
const { ZERO_ADDRESS } = require('../../../constants/general');

const WETH_KEY = ethers.encodeBytes32String('WETH');
const OVER_KEY = ethers.encodeBytes32String('OVER');
const WETH_PRICE = ethers.parseEther('3000');
const OVER_PRICE = ethers.parseEther('1');

const MAX_PROFIT_USD = ethers.parseEther('1000');
const CANCEL_TIMEOUT = 3600n;
const HOUSE_EDGE = ethers.parseEther('0.02'); // 2%
const MAX_PAYOUT_MULTIPLIER = ethers.parseEther('15'); // 15x max reserved profit
const ONE = ethers.parseEther('1');

const MIN_USDC_BET = 3n * 1_000_000n;

// SpinStatus enum
const Status = {
	NONE: 0n,
	PENDING: 1n,
	RESOLVED: 2n,
	CANCELLED: 3n,
};

// Symbol config: 5 symbols with equal weights
const SYMBOL_COUNT = 5;
const SYMBOL_WEIGHTS = [20n, 20n, 20n, 20n, 20n]; // equal probability = 1/5 each
const TOTAL_WEIGHT = 100n;

// Triple payouts (raw, before house edge) in 1e18 precision
// These are net-of-stake multipliers
const TRIPLE_PAYOUTS = [
	ethers.parseEther('2'), // symbol 0: 2x profit
	ethers.parseEther('5'), // symbol 1: 5x profit
	ethers.parseEther('8'), // symbol 2: 8x profit
	ethers.parseEther('10'), // symbol 3: 10x profit
	ethers.parseEther('15'), // symbol 4: 15x profit (jackpot)
];

// Helper: derive a reel result using keccak256 (matches contract logic)
function rollSymbol(word, reelIndex) {
	const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
		['uint256', 'uint256'],
		[word, reelIndex]
	);
	const hash = BigInt(ethers.keccak256(encoded));
	const rand = hash % TOTAL_WEIGHT;
	let acc = 0n;
	for (let i = 0; i < SYMBOL_COUNT; i++) {
		acc += SYMBOL_WEIGHTS[i];
		if (rand < acc) return i;
	}
	return 0;
}

// Helper: derive all 3 reels from a random word
function deriveReels(word) {
	return [rollSymbol(word, 0), rollSymbol(word, 1), rollSymbol(word, 2)];
}

// Helper: compute expected payout for a given random word
function getExpectedPayout(amount, word) {
	const [r1, r2, r3] = deriveReels(word);
	if (r1 === r2 && r2 === r3) {
		const rawMultiplier = TRIPLE_PAYOUTS[r1];
		const effectiveMultiplier = (rawMultiplier * (ONE - HOUSE_EDGE)) / ONE;
		return BigInt(amount) + (BigInt(amount) * effectiveMultiplier) / ONE;
	}
	return 0n;
}

// Helper: brute-force find a random word that gives triple of a specific symbol
function findTripleWord(symbol) {
	for (let i = 0n; i < 100000n; i++) {
		const [r1, r2, r3] = deriveReels(i);
		if (r1 === symbol && r2 === symbol && r3 === symbol) return i;
	}
	throw new Error(`Could not find triple word for symbol ${symbol}`);
}

// Helper: find a random word that gives no triple AND no pair (true loss)
// Needed because with pair payouts set, findLossWord-as-"not a triple" can land on a pair
function findTrueLossWord() {
	for (let i = 0n; i < 100000n; i++) {
		const [r1, r2, r3] = deriveReels(i);
		if (r1 !== r2 && r2 !== r3) return i; // neither adjacent pair
	}
	throw new Error('Could not find true loss word');
}

// Helper: find a random word that gives no triple
// Kept for backwards compatibility with existing tests that rely on pairPayout=0 defaults
function findLossWord() {
	return findTrueLossWord();
}

// Helper: find a random word that gives an adjacent pair (a==b, b!=c) of a specific symbol
function findFirstPairWord(symbol) {
	for (let i = 0n; i < 100000n; i++) {
		const [r1, r2, r3] = deriveReels(i);
		if (r1 === symbol && r2 === symbol && r3 !== symbol) return i;
	}
	throw new Error(`Could not find first-pair word for symbol ${symbol}`);
}

// Helper: find a random word that gives an adjacent pair (a!=b, b==c) of a specific symbol
function findLastPairWord(symbol) {
	for (let i = 0n; i < 100000n; i++) {
		const [r1, r2, r3] = deriveReels(i);
		if (r2 === symbol && r3 === symbol && r1 !== symbol) return i;
	}
	throw new Error(`Could not find last-pair word for symbol ${symbol}`);
}

// Helper: find a random word where a==c but b is different (NOT adjacent, should lose)
function findACPairWord() {
	for (let i = 0n; i < 100000n; i++) {
		const [r1, r2, r3] = deriveReels(i);
		if (r1 === r3 && r1 !== r2) return i;
	}
	throw new Error('Could not find AC-pair word');
}

async function deploySlotsFixture() {
	const [owner, secondAccount, resolver, riskManager, pauser, player] = await ethers.getSigners();

	const ExoticUSDC = await ethers.getContractFactory('ExoticUSDC');
	const usdc = await ExoticUSDC.deploy();

	const ExoticUSD = await ethers.getContractFactory('ExoticUSD');
	const weth = await ExoticUSD.deploy();
	const over = await ExoticUSD.deploy();

	const usdcAddress = await usdc.getAddress();
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

	await manager.setWhitelistedAddresses([resolver.address], 2, true);
	await manager.setWhitelistedAddresses([riskManager.address], 1, true);
	await manager.setWhitelistedAddresses([pauser.address], 3, true);

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

	// Configure symbols
	await slots.setSymbols(SYMBOL_COUNT, SYMBOL_WEIGHTS);
	for (let i = 0; i < TRIPLE_PAYOUTS.length; i++) {
		await slots.setTriplePayout(i, TRIPLE_PAYOUTS[i]);
	}

	// Fund bankroll
	await usdc.transfer(slotsAddress, 59n * 1_000_000n);

	// Fund player
	await usdc.transfer(player.address, 40n * 1_000_000n);

	return {
		slots,
		slotsAddress,
		usdc,
		usdcAddress,
		weth,
		wethAddress,
		over,
		overAddress,
		vrfCoordinator,
		manager,
		priceFeed,
		owner,
		secondAccount,
		resolver,
		riskManager,
		pauser,
		player,
	};
}

async function parseSpinPlaced(slots, tx) {
	const receipt = await tx.wait();
	const parsed = receipt.logs
		.map((log) => {
			try {
				return slots.interface.parseLog(log);
			} catch {
				return null;
			}
		})
		.find((e) => e?.name === 'SpinPlaced');
	return { spinId: parsed.args.spinId, requestId: parsed.args.requestId };
}

describe('Slots', () => {
	let slots, slotsAddress, usdc, usdcAddress, weth, wethAddress, over, overAddress, vrfCoordinator;
	let owner, secondAccount, resolver, riskManager, pauser, player;

	beforeEach(async () => {
		({
			slots,
			slotsAddress,
			usdc,
			usdcAddress,
			weth,
			wethAddress,
			over,
			overAddress,
			vrfCoordinator,
			owner,
			secondAccount,
			resolver,
			riskManager,
			pauser,
			player,
		} = await loadFixture(deploySlotsFixture));
	});

	/* ========== INITIALIZATION ========== */

	describe('Initialization', () => {
		it('should set correct state after initialize', async () => {
			expect(await slots.owner()).to.equal(owner.address);
			expect(await slots.usdc()).to.equal(usdcAddress);
			expect(await slots.maxProfitUsd()).to.equal(MAX_PROFIT_USD);
			expect(await slots.cancelTimeout()).to.equal(CANCEL_TIMEOUT);
			expect(await slots.houseEdge()).to.equal(HOUSE_EDGE);
			expect(await slots.maxPayoutMultiplier()).to.equal(MAX_PAYOUT_MULTIPLIER);
			expect(await slots.nextSpinId()).to.equal(1n);
			expect(await slots.symbolCount()).to.equal(SYMBOL_COUNT);
		});

		it('should revert on re-initialization', async () => {
			await expect(
				slots.initialize(
					{
						owner: owner.address,
						manager: owner.address,
						priceFeed: owner.address,
						vrfCoordinator: owner.address,
					},
					{
						usdc: usdcAddress,
						weth: usdcAddress,
						over: usdcAddress,
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
				)
			).to.be.reverted;
		});

		it('should revert with zero house edge', async () => {
			const SlotsFactory = await ethers.getContractFactory('Slots');
			const s = await upgrades.deployProxy(SlotsFactory, [], { initializer: false });
			await expect(
				s.initialize(
					{
						owner: owner.address,
						manager: owner.address,
						priceFeed: owner.address,
						vrfCoordinator: owner.address,
					},
					{
						usdc: usdcAddress,
						weth: usdcAddress,
						over: usdcAddress,
						wethPriceFeedKey: WETH_KEY,
						overPriceFeedKey: OVER_KEY,
					},
					MAX_PROFIT_USD,
					CANCEL_TIMEOUT,
					0,
					MAX_PAYOUT_MULTIPLIER,
					{
						subscriptionId: 1,
						keyHash: ethers.ZeroHash,
						callbackGasLimit: 500000,
						requestConfirmations: 3,
						nativePayment: false,
					}
				)
			).to.be.revertedWithCustomError(s, 'InvalidHouseEdge');
		});

		it('should revert with zero address', async () => {
			const SlotsFactory = await ethers.getContractFactory('Slots');
			const s = await upgrades.deployProxy(SlotsFactory, [], { initializer: false });
			await expect(
				s.initialize(
					{
						owner: ZERO_ADDRESS,
						manager: owner.address,
						priceFeed: owner.address,
						vrfCoordinator: owner.address,
					},
					{
						usdc: usdcAddress,
						weth: usdcAddress,
						over: usdcAddress,
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
				)
			).to.be.revertedWithCustomError(s, 'InvalidAddress');
		});
	});

	/* ========== SPIN ========== */

	describe('spin', () => {
		it('should revert for unsupported collateral', async () => {
			await expect(
				slots.connect(player).spin(secondAccount.address, MIN_USDC_BET, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(slots, 'InvalidCollateral');
		});

		it('should revert for zero amount', async () => {
			await expect(
				slots.connect(player).spin(usdcAddress, 0, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(slots, 'InvalidAmount');
		});

		it('should revert for below min bet', async () => {
			await usdc.connect(player).approve(slotsAddress, 1n);
			await expect(
				slots.connect(player).spin(usdcAddress, 1n, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(slots, 'InvalidAmount');
		});

		it('should revert when paused', async () => {
			await slots.connect(pauser).setPausedByRole(true);
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			await expect(slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress)).to.be
				.reverted;
		});

		it('should revert when aggregate payout liability of pending spins exceeds balance', async () => {
			// Bankroll 59 USDC. Per spin: stake 3, reserved profit = stake * maxPayoutMultiplier(15x) = 45,
			// aggregator = 48 per spin. After N spins: balance = 59 + 3N, reserved = 48N.
			// Solvent while: 59 + 3N >= 48N  →  N ≤ 1. 2nd spin must revert.
			const bet = MIN_USDC_BET;
			await usdc.connect(player).approve(slotsAddress, bet * 5n);
			await slots.connect(player).spin(usdcAddress, bet, ethers.ZeroAddress);
			await expect(
				slots.connect(player).spin(usdcAddress, bet, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(slots, 'InsufficientAvailableLiquidity');
		});

		it('should place a spin and emit SpinPlaced', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			await expect(slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress))
				.to.emit(slots, 'SpinPlaced')
				.withArgs(1n, 1n, player.address, usdcAddress, MIN_USDC_BET);

			const spinBase = await slots.getSpinBase(1n);
			const spinDetails = await slots.getSpinDetails(1n);
			expect(spinBase.user).to.equal(player.address);
			expect(spinDetails.status).to.equal(Status.PENDING);
			expect(await slots.nextSpinId()).to.equal(2n);
		});

		it('should transfer collateral from player', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const balBefore = await usdc.balanceOf(player.address);
			await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore - MIN_USDC_BET);
		});

		it('should reserve profit', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const reserved = await slots.reservedProfitPerCollateral(usdcAddress);
			// Aggregator tracks stake + profit for solvency against worst-case payout
			const expectedReserved = MIN_USDC_BET + (MIN_USDC_BET * MAX_PAYOUT_MULTIPLIER) / ONE;
			expect(reserved).to.equal(expectedReserved);
		});
	});

	/* ========== VRF RESOLUTION ========== */

	describe('Resolution', () => {
		it('should resolve as win on triple match (symbol 0)', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { spinId, requestId } = await parseSpinPlaced(slots, tx);

			const playerBalBefore = await usdc.balanceOf(player.address);

			const tripleWord = findTripleWord(0);
			await vrfCoordinator.fulfillRandomWords(slotsAddress, requestId, [tripleWord]);

			const spinDetails = await slots.getSpinDetails(spinId);
			const spinBase = await slots.getSpinBase(spinId);
			expect(spinDetails.status).to.equal(Status.RESOLVED);
			expect(spinDetails.won).to.equal(true);

			const expectedPayout = getExpectedPayout(MIN_USDC_BET, tripleWord);
			expect(spinBase.payout).to.equal(expectedPayout);
			expect(expectedPayout).to.be.gt(0n);
			expect(await usdc.balanceOf(player.address)).to.equal(playerBalBefore + expectedPayout);
		});

		it('should resolve as win on jackpot triple (symbol 4)', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { spinId, requestId } = await parseSpinPlaced(slots, tx);

			const tripleWord = findTripleWord(4);
			await vrfCoordinator.fulfillRandomWords(slotsAddress, requestId, [tripleWord]);

			const spinDetails = await slots.getSpinDetails(spinId);
			const spinBase = await slots.getSpinBase(spinId);
			expect(spinDetails.won).to.equal(true);

			const expectedPayout = getExpectedPayout(MIN_USDC_BET, tripleWord);
			expect(spinBase.payout).to.equal(expectedPayout);
		});

		it('should resolve as loss on non-matching reels', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { spinId, requestId } = await parseSpinPlaced(slots, tx);

			const lossWord = findLossWord();
			await vrfCoordinator.fulfillRandomWords(slotsAddress, requestId, [lossWord]);

			const spinDetails = await slots.getSpinDetails(spinId);
			const spinBase = await slots.getSpinBase(spinId);
			expect(spinDetails.status).to.equal(Status.RESOLVED);
			expect(spinDetails.won).to.equal(false);
			expect(spinBase.payout).to.equal(0n);
		});

		it('should release reserved profit on resolution', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { requestId } = await parseSpinPlaced(slots, tx);

			const reservedBefore = await slots.reservedProfitPerCollateral(usdcAddress);
			expect(reservedBefore).to.be.gt(0n);

			await vrfCoordinator.fulfillRandomWords(slotsAddress, requestId, [findLossWord()]);

			expect(await slots.reservedProfitPerCollateral(usdcAddress)).to.equal(0n);
		});

		it('should emit SpinResolved event', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { requestId } = await parseSpinPlaced(slots, tx);

			await expect(
				vrfCoordinator.fulfillRandomWords(slotsAddress, requestId, [findLossWord()])
			).to.emit(slots, 'SpinResolved');
		});

		it('should not resolve already resolved spin', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { spinId, requestId } = await parseSpinPlaced(slots, tx);

			await vrfCoordinator.fulfillRandomWords(slotsAddress, requestId, [findLossWord()]);

			// Second fulfillment should be no-op
			await vrfCoordinator.fulfillRandomWords(slotsAddress, requestId, [findTripleWord(4)]);

			const spinDetails = await slots.getSpinDetails(spinId);
			expect(spinDetails.won).to.equal(false); // still loss from first resolution
		});
	});

	/* ========== CANCEL ========== */

	describe('cancelSpin', () => {
		it('should revert if timeout not reached', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { spinId } = await parseSpinPlaced(slots, tx);

			await expect(slots.connect(player).cancelSpin(spinId)).to.be.revertedWithCustomError(
				slots,
				'CancelTimeoutNotReached'
			);
		});

		it('should revert if not spin owner', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { spinId } = await parseSpinPlaced(slots, tx);

			await time.increase(CANCEL_TIMEOUT);
			await expect(slots.connect(secondAccount).cancelSpin(spinId)).to.be.revertedWithCustomError(
				slots,
				'SpinNotOwner'
			);
		});

		it('should cancel after timeout and refund', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { spinId } = await parseSpinPlaced(slots, tx);

			const balBefore = await usdc.balanceOf(player.address);
			await time.increase(CANCEL_TIMEOUT);

			await expect(slots.connect(player).cancelSpin(spinId)).to.emit(slots, 'SpinCancelled');

			expect(await usdc.balanceOf(player.address)).to.equal(balBefore + MIN_USDC_BET);
			const spinDetails = await slots.getSpinDetails(spinId);
			const spinBase = await slots.getSpinBase(spinId);
			expect(spinDetails.status).to.equal(Status.CANCELLED);
			expect(spinBase.payout).to.equal(MIN_USDC_BET);
		});

		it('should release reserved profit on cancel', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { spinId } = await parseSpinPlaced(slots, tx);

			await time.increase(CANCEL_TIMEOUT);
			await slots.connect(player).cancelSpin(spinId);

			expect(await slots.reservedProfitPerCollateral(usdcAddress)).to.equal(0n);
		});

		it('should revert cancel on non-existing spin', async () => {
			await expect(slots.connect(player).cancelSpin(999)).to.be.revertedWithCustomError(
				slots,
				'SpinNotFound'
			);
		});

		it('should revert cancel on already resolved spin', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { spinId, requestId } = await parseSpinPlaced(slots, tx);

			await vrfCoordinator.fulfillRandomWords(slotsAddress, requestId, [findLossWord()]);

			await time.increase(CANCEL_TIMEOUT);
			await expect(slots.connect(player).cancelSpin(spinId)).to.be.revertedWithCustomError(
				slots,
				'SpinNotPending'
			);
		});
	});

	/* ========== ADMIN CANCEL ========== */

	describe('adminCancelSpin', () => {
		it('should revert for non-resolver', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { spinId } = await parseSpinPlaced(slots, tx);

			await expect(
				slots.connect(secondAccount).adminCancelSpin(spinId)
			).to.be.revertedWithCustomError(slots, 'InvalidSender');
		});

		it('should allow owner to admin cancel', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { spinId } = await parseSpinPlaced(slots, tx);

			await expect(slots.connect(owner).adminCancelSpin(spinId)).to.emit(slots, 'SpinCancelled');
		});

		it('should allow resolver to admin cancel', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { spinId } = await parseSpinPlaced(slots, tx);

			await expect(slots.connect(resolver).adminCancelSpin(spinId)).to.emit(slots, 'SpinCancelled');
		});
	});

	/* ========== WITHDRAW COLLATERAL ========== */

	describe('withdrawCollateral', () => {
		it('should allow owner to withdraw', async () => {
			const amount = 10n * 1_000_000n;
			await expect(
				slots.connect(owner).withdrawCollateral(usdcAddress, secondAccount.address, amount)
			)
				.to.emit(slots, 'WithdrawnCollateral')
				.withArgs(usdcAddress, secondAccount.address, amount);
		});

		it('should revert for non-owner', async () => {
			await expect(
				slots.connect(secondAccount).withdrawCollateral(usdcAddress, secondAccount.address, 1n)
			).to.be.reverted;
		});
	});

	/* ========== SPLIT GETTERS ========== */

	describe('Split Getters', () => {
		it('getSpinBase returns correct values after placing a spin', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { spinId } = await parseSpinPlaced(slots, tx);

			const spinBase = await slots.getSpinBase(spinId);
			expect(spinBase.user).to.equal(player.address);
			expect(spinBase.collateral).to.equal(usdcAddress);
			expect(spinBase.amount).to.equal(MIN_USDC_BET);
			expect(spinBase.payout).to.equal(0n);
			const expectedReserved = (MIN_USDC_BET * MAX_PAYOUT_MULTIPLIER) / ONE;
			expect(spinBase.reservedProfit).to.equal(expectedReserved);
		});

		it('getSpinDetails returns correct values after resolution', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { spinId, requestId } = await parseSpinPlaced(slots, tx);

			const tripleWord = findTripleWord(0);
			await vrfCoordinator.fulfillRandomWords(slotsAddress, requestId, [tripleWord]);

			const spinDetails = await slots.getSpinDetails(spinId);
			expect(spinDetails.status).to.equal(Status.RESOLVED);
			expect(spinDetails.won).to.equal(true);
			expect(spinDetails.reels[0]).to.equal(0n);
			expect(spinDetails.reels[1]).to.equal(0n);
			expect(spinDetails.reels[2]).to.equal(0n);
		});
	});

	/* ========== AUDIT FIXES ========== */

	describe('Audit Fixes', () => {
		it('withdrawCollateral should revert when amount exceeds available (reserved funds protection)', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);

			const balance = await usdc.balanceOf(slotsAddress);
			await expect(
				slots.connect(owner).withdrawCollateral(usdcAddress, secondAccount.address, balance)
			).to.be.revertedWithCustomError(slots, 'InsufficientAvailableLiquidity');
		});

		it('setCancelTimeout should revert below MIN_CANCEL_TIMEOUT (30)', async () => {
			await expect(slots.connect(owner).setCancelTimeout(29)).to.be.revertedWithCustomError(
				slots,
				'InvalidAmount'
			);
		});

		it('setCancelTimeout should succeed at MIN_CANCEL_TIMEOUT', async () => {
			await expect(slots.connect(owner).setCancelTimeout(30))
				.to.emit(slots, 'CancelTimeoutChanged')
				.withArgs(30);
		});

		it('setMaxPayoutMultiplier should revert when below existing triplePayout', async () => {
			// TRIPLE_PAYOUTS[4] = 15e18, so setting maxPayoutMultiplier to 10e18 should fail
			await expect(
				slots.connect(owner).setMaxPayoutMultiplier(ethers.parseEther('10'))
			).to.be.revertedWithCustomError(slots, 'InvalidConfig');
		});

		it('setTriplePayout should revert for symbol >= symbolCount', async () => {
			await expect(
				slots.connect(owner).setTriplePayout(SYMBOL_COUNT, ethers.parseEther('5'))
			).to.be.revertedWithCustomError(slots, 'InvalidConfig');
		});

		it('setTriplePayout should revert for multiplier > maxPayoutMultiplier', async () => {
			await expect(
				slots.connect(owner).setTriplePayout(0, ethers.parseEther('100'))
			).to.be.revertedWithCustomError(slots, 'InvalidConfig');
		});
	});

	/* ========== FREE BET PATHS ========== */

	describe('FreeBet Paths', () => {
		it('spinWithFreeBet should revert for unsupported collateral', async () => {
			await expect(
				slots.connect(player).spinWithFreeBet(secondAccount.address, MIN_USDC_BET)
			).to.be.revertedWithCustomError(slots, 'InvalidCollateral');
		});

		it('spinWithFreeBet should revert when freeBetsHolder is not set', async () => {
			await expect(slots.connect(player).spinWithFreeBet(usdcAddress, MIN_USDC_BET)).to.be.reverted;
		});

		it('setFreeBetsHolder should emit event', async () => {
			await expect(slots.connect(owner).setFreeBetsHolder(secondAccount.address))
				.to.emit(slots, 'FreeBetsHolderChanged')
				.withArgs(secondAccount.address);
		});

		it('normal spin isFreeBet should be false', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			expect(await slots.isFreeBet(1)).to.equal(false);
		});

		it('isFreeBet returns false for non-existent spin', async () => {
			expect(await slots.isFreeBet(999)).to.equal(false);
		});
	});

	/* ========== GETTERS ========== */

	describe('Getters', () => {
		it('getAvailableLiquidity should return bankroll minus reserved', async () => {
			expect(await slots.getAvailableLiquidity(usdcAddress)).to.equal(59n * 1_000_000n);
		});

		it('getAvailableLiquidity should decrease after spin', async () => {
			const before = await slots.getAvailableLiquidity(usdcAddress);
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const after = await slots.getAvailableLiquidity(usdcAddress);
			expect(after).to.be.lt(before);
		});

		it('getSymbolWeights should return weights array', async () => {
			const weights = await slots.getSymbolWeights();
			expect(weights.length).to.equal(SYMBOL_COUNT);
			for (let i = 0; i < SYMBOL_COUNT; i++) {
				expect(weights[i]).to.equal(SYMBOL_WEIGHTS[i]);
			}
		});
	});

	/* ========== SETTERS ========== */

	describe('Setters', () => {
		it('setHouseEdge should update and emit', async () => {
			const newEdge = ethers.parseEther('0.03');
			await expect(slots.connect(owner).setHouseEdge(newEdge))
				.to.emit(slots, 'HouseEdgeChanged')
				.withArgs(newEdge);
			expect(await slots.houseEdge()).to.equal(newEdge);
		});

		it('setHouseEdge should revert for zero', async () => {
			await expect(slots.connect(owner).setHouseEdge(0)).to.be.revertedWithCustomError(
				slots,
				'InvalidHouseEdge'
			);
		});

		it('setHouseEdge should revert for > MAX_HOUSE_EDGE', async () => {
			const tooHigh = ethers.parseEther('0.06');
			await expect(slots.connect(owner).setHouseEdge(tooHigh)).to.be.revertedWithCustomError(
				slots,
				'InvalidHouseEdge'
			);
		});

		it('setMaxProfitUsd should update and emit', async () => {
			const newMax = ethers.parseEther('2000');
			await expect(slots.connect(owner).setMaxProfitUsd(newMax))
				.to.emit(slots, 'MaxProfitUsdChanged')
				.withArgs(newMax);
			expect(await slots.maxProfitUsd()).to.equal(newMax);
		});

		it('setMaxProfitUsd should revert for zero', async () => {
			await expect(slots.connect(owner).setMaxProfitUsd(0)).to.be.revertedWithCustomError(
				slots,
				'InvalidAmount'
			);
		});

		it('setMaxProfitUsd should revert from non-risk-manager', async () => {
			await expect(
				slots.connect(secondAccount).setMaxProfitUsd(ethers.parseEther('500'))
			).to.be.revertedWithCustomError(slots, 'InvalidSender');
		});

		it('setPausedByRole should revert from non-pauser', async () => {
			await expect(
				slots.connect(secondAccount).setPausedByRole(true)
			).to.be.revertedWithCustomError(slots, 'InvalidSender');
		});

		it('spin should revert and rollback reservedProfit on insufficient liquidity', async () => {
			const balance = await usdc.balanceOf(slotsAddress);
			await slots.connect(owner).withdrawCollateral(usdcAddress, owner.address, balance);

			const reservedBefore = await slots.reservedProfitPerCollateral(usdcAddress);

			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			await expect(
				slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(slots, 'InsufficientAvailableLiquidity');

			const reservedAfter = await slots.reservedProfitPerCollateral(usdcAddress);
			expect(reservedAfter).to.equal(reservedBefore);
		});

		it('setCancelTimeout should update and emit', async () => {
			await expect(slots.connect(owner).setCancelTimeout(7200))
				.to.emit(slots, 'CancelTimeoutChanged')
				.withArgs(7200);
		});

		it('setMaxPayoutMultiplier should update and emit', async () => {
			const newMult = ethers.parseEther('100');
			await expect(slots.connect(owner).setMaxPayoutMultiplier(newMult))
				.to.emit(slots, 'MaxPayoutMultiplierChanged')
				.withArgs(newMult);
		});

		it('setSymbols should revert with zero count', async () => {
			await expect(slots.connect(owner).setSymbols(0, [])).to.be.revertedWithCustomError(
				slots,
				'InvalidConfig'
			);
		});

		it('setSymbols should revert with mismatched length', async () => {
			await expect(slots.connect(owner).setSymbols(3, [1n, 2n])).to.be.revertedWithCustomError(
				slots,
				'InvalidConfig'
			);
		});

		it('riskManager should be able to set risk params', async () => {
			await expect(slots.connect(riskManager).setMaxProfitUsd(ethers.parseEther('500'))).to.emit(
				slots,
				'MaxProfitUsdChanged'
			);
			await expect(slots.connect(riskManager).setCancelTimeout(1800)).to.emit(
				slots,
				'CancelTimeoutChanged'
			);
			await expect(slots.connect(riskManager).setHouseEdge(ethers.parseEther('0.01'))).to.emit(
				slots,
				'HouseEdgeChanged'
			);
		});

		it('non-riskManager should not set risk params', async () => {
			await expect(
				slots.connect(secondAccount).setMaxProfitUsd(ethers.parseEther('500'))
			).to.be.revertedWithCustomError(slots, 'InvalidSender');
		});

		it('setManager should revert for zero address', async () => {
			await expect(slots.connect(owner).setManager(ZERO_ADDRESS)).to.be.revertedWithCustomError(
				slots,
				'InvalidAddress'
			);
		});

		it('setPriceFeed should revert for zero address', async () => {
			await expect(slots.connect(owner).setPriceFeed(ZERO_ADDRESS)).to.be.revertedWithCustomError(
				slots,
				'InvalidAddress'
			);
		});

		it('setVrfCoordinator should revert for zero address', async () => {
			await expect(
				slots.connect(owner).setVrfCoordinator(ZERO_ADDRESS)
			).to.be.revertedWithCustomError(slots, 'InvalidAddress');
		});

		it('setSupportedCollateral should revert for zero address', async () => {
			await expect(
				slots.connect(owner).setSupportedCollateral(ZERO_ADDRESS, true)
			).to.be.revertedWithCustomError(slots, 'InvalidAddress');
		});

		it('setPriceFeedKeyPerCollateral should revert for zero address', async () => {
			await expect(
				slots.connect(owner).setPriceFeedKeyPerCollateral(ZERO_ADDRESS, WETH_KEY)
			).to.be.revertedWithCustomError(slots, 'InvalidAddress');
		});

		it('setSupportedCollateral should emit', async () => {
			await expect(slots.connect(owner).setSupportedCollateral(secondAccount.address, true))
				.to.emit(slots, 'SupportedCollateralChanged')
				.withArgs(secondAccount.address, true);
		});

		it('setPriceFeedKeyPerCollateral should emit', async () => {
			const testKey = ethers.encodeBytes32String('TEST');
			await expect(
				slots.connect(owner).setPriceFeedKeyPerCollateral(secondAccount.address, testKey)
			)
				.to.emit(slots, 'PriceFeedKeyPerCollateralChanged')
				.withArgs(secondAccount.address, testKey);
		});

		it('setManager should emit', async () => {
			await expect(slots.connect(owner).setManager(secondAccount.address))
				.to.emit(slots, 'ManagerChanged')
				.withArgs(secondAccount.address);
		});

		it('setPriceFeed should emit', async () => {
			await expect(slots.connect(owner).setPriceFeed(secondAccount.address))
				.to.emit(slots, 'PriceFeedChanged')
				.withArgs(secondAccount.address);
		});

		it('setVrfCoordinator should emit', async () => {
			await expect(slots.connect(owner).setVrfCoordinator(secondAccount.address))
				.to.emit(slots, 'VrfCoordinatorChanged')
				.withArgs(secondAccount.address);
		});

		it('setVrfConfig should update config and emit', async () => {
			const kh = ethers.encodeBytes32String('keyhash');
			await expect(slots.connect(owner).setVrfConfig(2n, kh, 300000n, 5n, true))
				.to.emit(slots, 'VrfConfigChanged')
				.withArgs(2n, kh, 300000n, 5n, true);
			expect(await slots.callbackGasLimit()).to.equal(300000n);
			expect(await slots.requestConfirmations()).to.equal(5n);
		});

		it('setVrfConfig should revert for zero callbackGasLimit', async () => {
			const kh = ethers.encodeBytes32String('keyhash');
			await expect(
				slots.connect(owner).setVrfConfig(1n, kh, 0n, 3n, false)
			).to.be.revertedWithCustomError(slots, 'InvalidAmount');
		});

		it('setVrfConfig should accept zero requestConfirmations', async () => {
			const kh = ethers.encodeBytes32String('keyhash');
			await expect(slots.connect(owner).setVrfConfig(1n, kh, 500000n, 0n, false)).to.emit(
				slots,
				'VrfConfigChanged'
			);
		});
	});

	/* ========== VRF AUTH ========== */

	describe('VRF auth', () => {
		it('should revert rawFulfillRandomWords from non-coordinator', async () => {
			await expect(
				slots.connect(secondAccount).rawFulfillRandomWords(1n, [7n])
			).to.be.revertedWithCustomError(slots, 'InvalidSender');
		});
	});

	/* ========== PAUSE ========== */

	describe('Pause', () => {
		it('should allow pauser to pause', async () => {
			await expect(slots.connect(pauser).setPausedByRole(true))
				.to.emit(slots, 'PauseChanged')
				.withArgs(true);
		});

		it('should revert pause from non-pauser', async () => {
			await expect(
				slots.connect(secondAccount).setPausedByRole(true)
			).to.be.revertedWithCustomError(slots, 'InvalidSender');
		});
	});

	/* ========== SPIN HISTORY ========== */

	describe('Spin History', () => {
		// Lower payouts and maxPayoutMultiplier so multiple spins can be placed with limited bankroll
		beforeEach(async () => {
			for (let i = 0; i < SYMBOL_COUNT; i++) {
				await slots.connect(owner).setTriplePayout(i, ethers.parseEther('5'));
			}
			await slots.connect(owner).setMaxPayoutMultiplier(ethers.parseEther('5'));
		});

		it('getUserSpinCount should return 0 for new user', async () => {
			expect(await slots.getUserSpinCount(player.address)).to.equal(0n);
		});

		it('getUserSpinCount should increment after placing spins', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET * 2n);
			await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			expect(await slots.getUserSpinCount(player.address)).to.equal(1n);

			await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			expect(await slots.getUserSpinCount(player.address)).to.equal(2n);
		});

		it('getUserSpinIds should return spin IDs in reverse chronological order', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET * 3n);
			await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);

			const ids = await slots.getUserSpinIds(player.address, 0, 10);
			expect(ids.length).to.equal(3);
			// Most recent first - IDs should be 3, 2, 1
			expect(ids[0]).to.equal(3n);
			expect(ids[1]).to.equal(2n);
			expect(ids[2]).to.equal(1n);
		});

		it('getUserSpinIds should paginate correctly', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET * 3n);
			await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);

			const page1 = await slots.getUserSpinIds(player.address, 0, 2);
			expect(page1.length).to.equal(2);
			expect(page1[0]).to.equal(3n);

			const page2 = await slots.getUserSpinIds(player.address, 2, 2);
			expect(page2.length).to.equal(1);
			expect(page2[0]).to.equal(1n);
		});

		it('getUserSpinIds should return empty for offset beyond length', async () => {
			const ids = await slots.getUserSpinIds(player.address, 100, 10);
			expect(ids.length).to.equal(0);
		});

		it('getRecentSpinIds should return spin IDs in reverse chronological order', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET * 2n);
			await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);

			const ids = await slots.getRecentSpinIds(0, 10);
			expect(ids.length).to.equal(2);
			const spinBase = await slots.getSpinBase(ids[0]);
			expect(spinBase.user).to.equal(player.address);
		});

		it('should not include other users spins in getUserSpinIds', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);

			expect(await slots.getUserSpinCount(secondAccount.address)).to.equal(0n);
			const ids = await slots.getUserSpinIds(secondAccount.address, 0, 10);
			expect(ids.length).to.equal(0);
		});

		it('getSpinDetails should include reels after resolution', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { spinId, requestId } = await parseSpinPlaced(slots, tx);

			// Resolve so reels are populated
			await vrfCoordinator.fulfillRandomWords(slotsAddress, requestId, [findTripleWord(0)]);

			const ids = await slots.getUserSpinIds(player.address, 0, 1);
			expect(ids.length).to.equal(1);
			expect(ids[0]).to.equal(spinId);
			const spinDetails = await slots.getSpinDetails(ids[0]);
			expect(spinDetails.reels[0]).to.equal(0n);
			expect(spinDetails.reels[1]).to.equal(0n);
			expect(spinDetails.reels[2]).to.equal(0n);
			expect(spinDetails.won).to.equal(true);
		});

		it('getRecentSpinIds should return IDs with details via getters', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);

			const ids = await slots.getRecentSpinIds(0, 1);
			expect(ids[0]).to.equal(1n);
			const spinBase = await slots.getSpinBase(ids[0]);
			expect(spinBase.amount).to.equal(MIN_USDC_BET);
		});

		it('getRecentSpinIds should return empty when offset >= total', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);

			const ids = await slots.getRecentSpinIds(100, 10);
			expect(ids.length).to.equal(0);
		});
	});

	/* ========== COLLATERAL PRICE ========== */

	describe('getCollateralPrice', () => {
		it('should return ONE for USDC', async () => {
			expect(await slots.getCollateralPrice(usdcAddress)).to.equal(ethers.parseEther('1'));
		});

		it('should return the price feed value for WETH', async () => {
			expect(await slots.getCollateralPrice(wethAddress)).to.equal(WETH_PRICE);
		});

		it('should revert for unsupported collateral', async () => {
			await expect(slots.getCollateralPrice(secondAccount.address)).to.be.revertedWithCustomError(
				slots,
				'InvalidCollateral'
			);
		});
	});

	/* ========== GET SPIN REELS ========== */

	describe('getSpinReels', () => {
		it('should return correct reel symbols after resolution', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { spinId, requestId } = await parseSpinPlaced(slots, tx);

			const tripleWord = findTripleWord(2);
			await vrfCoordinator.fulfillRandomWords(slotsAddress, requestId, [tripleWord]);

			const reels = await slots.getSpinReels(spinId);
			expect(reels[0]).to.equal(2n);
			expect(reels[1]).to.equal(2n);
			expect(reels[2]).to.equal(2n);
		});

		it('should return zeros for unresolved spin', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { spinId } = await parseSpinPlaced(slots, tx);

			const reels = await slots.getSpinReels(spinId);
			expect(reels[0]).to.equal(0n);
			expect(reels[1]).to.equal(0n);
			expect(reels[2]).to.equal(0n);
		});
	});

	/* ========== VRF UNKNOWN REQUEST ========== */

	describe('VRF unknown requestId', () => {
		it('should silently skip an unknown requestId', async () => {
			await expect(vrfCoordinator.fulfillRandomWords(slotsAddress, 999n, [42n])).to.not.be.reverted;
		});
	});

	/* ========== WETH COLLATERAL ========== */

	describe('WETH Collateral', () => {
		const MIN_WETH_BET = ethers.parseEther('0.001'); // 0.001 WETH = 3 USD at 3000 USD/WETH

		beforeEach(async () => {
			// Fund bankroll with WETH
			await weth.transfer(slotsAddress, ethers.parseEther('10'));
			// Fund player with WETH
			await weth.transfer(player.address, ethers.parseEther('1'));
		});

		it('should place a WETH spin and resolve as win', async () => {
			await weth.connect(player).approve(slotsAddress, MIN_WETH_BET);
			const tx = await slots.connect(player).spin(wethAddress, MIN_WETH_BET, ethers.ZeroAddress);
			const { spinId, requestId } = await parseSpinPlaced(slots, tx);

			const playerBalBefore = await weth.balanceOf(player.address);

			const tripleWord = findTripleWord(0);
			await vrfCoordinator.fulfillRandomWords(slotsAddress, requestId, [tripleWord]);

			const spinDetails = await slots.getSpinDetails(spinId);
			const spinBase = await slots.getSpinBase(spinId);
			expect(spinDetails.status).to.equal(Status.RESOLVED);
			expect(spinDetails.won).to.equal(true);

			const expectedPayout = getExpectedPayout(MIN_WETH_BET, tripleWord);
			expect(spinBase.payout).to.equal(expectedPayout);
			expect(await weth.balanceOf(player.address)).to.equal(playerBalBefore + expectedPayout);
		});
	});

	/* ========== TRIPLE WITH ZERO PAYOUT ========== */

	describe('Triple match with zero payout', () => {
		it('should resolve as loss when triple matches but payout is 0', async () => {
			// Set triple payout for symbol 0 to 0
			await slots.connect(owner).setTriplePayout(0, 0);

			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { spinId, requestId } = await parseSpinPlaced(slots, tx);

			const tripleWord = findTripleWord(0);
			await vrfCoordinator.fulfillRandomWords(slotsAddress, requestId, [tripleWord]);

			const spinDetails = await slots.getSpinDetails(spinId);
			const spinBase = await slots.getSpinBase(spinId);
			expect(spinDetails.status).to.equal(Status.RESOLVED);
			// With 0 payout multiplier, the spin resolves but with 0 payout (loss)
			expect(spinBase.payout).to.equal(0n);
			expect(spinDetails.won).to.equal(false);
		});
	});

	/* ========== FREE BET WIN RESOLUTION ========== */

	describe('FreeBet Win Resolution', () => {
		it('should send profit to user and stake to holder owner on freebet triple win', async () => {
			// Deploy FreeBetsHolder inline
			const HolderFactory = await ethers.getContractFactory('FreeBetsHolder');
			const holder = await upgrades.deployProxy(HolderFactory, [], { initializer: false });
			await holder.initialize(owner.address, owner.address, owner.address);
			const holderAddress = await holder.getAddress();
			await holder.addSupportedCollateral(usdcAddress, true, owner.address);
			await holder.setFreeBetExpirationPeriod(86400, Math.floor(Date.now() / 1000));

			// Set holder on slots
			await slots.connect(owner).setFreeBetsHolder(holderAddress);
			// Whitelist slots in holder
			await holder.setWhitelistedCasino(slotsAddress, true);

			// Fund holder with USDC (use player's USDC since owner has limited supply after fixture)
			await usdc.connect(player).approve(holderAddress, MIN_USDC_BET);
			await holder.connect(player).fund(player.address, usdcAddress, MIN_USDC_BET);

			// Place freebet spin
			const tx = await slots.connect(player).spinWithFreeBet(usdcAddress, MIN_USDC_BET);
			const { spinId, requestId } = await parseSpinPlaced(slots, tx);

			expect(await slots.isFreeBet(spinId)).to.equal(true);

			const playerBalBefore = await usdc.balanceOf(player.address);
			const holderBalBefore = await usdc.balanceOf(holderAddress);
			const ownerBalBefore = await usdc.balanceOf(owner.address);

			// Use a triple word for symbol 0 (lowest payout to stay within bankroll)
			const tripleWord = findTripleWord(0);
			await vrfCoordinator.fulfillRandomWords(slotsAddress, requestId, [tripleWord]);

			const spinDetails = await slots.getSpinDetails(spinId);
			const spinBase = await slots.getSpinBase(spinId);
			expect(spinDetails.won).to.equal(true);

			// Player gets profit (payout - amount)
			const profit = spinBase.payout - MIN_USDC_BET;
			const playerBalAfter = await usdc.balanceOf(player.address);
			expect(playerBalAfter - playerBalBefore).to.equal(profit);

			// Stake is forwarded to holder owner; holder itself nets zero
			const holderBalAfter = await usdc.balanceOf(holderAddress);
			expect(holderBalAfter - holderBalBefore).to.equal(0n);
			const ownerBalAfter = await usdc.balanceOf(owner.address);
			expect(ownerBalAfter - ownerBalBefore).to.equal(MIN_USDC_BET);
		});
	});

	/* ========== REFERRALS ========== */

	describe('Referrals', () => {
		let mockReferrals, mockReferralsAddress;
		const REFERRER_FEE = ethers.parseEther('0.005'); // 0.5%
		const ONE = ethers.parseEther('1');

		beforeEach(async () => {
			const MockReferralsFactory = await ethers.getContractFactory('MockReferrals');
			mockReferrals = await MockReferralsFactory.deploy();
			mockReferralsAddress = await mockReferrals.getAddress();
			await mockReferrals.setReferrerFees(REFERRER_FEE, REFERRER_FEE, REFERRER_FEE);
			await slots.setReferrals(mockReferralsAddress);
		});

		it('should set referrer on spin', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, secondAccount.address);
			expect(await mockReferrals.referrals(player.address)).to.equal(secondAccount.address);
		});

		it('should NOT set referrer when zero address', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			expect(await mockReferrals.referrals(player.address)).to.equal(ethers.ZeroAddress);
		});

		it('should pay referrer on losing spin', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, secondAccount.address);
			const { requestId } = await parseSpinPlaced(slots, tx);

			const referrerBalBefore = await usdc.balanceOf(secondAccount.address);
			await vrfCoordinator.fulfillRandomWords(slotsAddress, requestId, [findLossWord()]);

			const referrerBalAfter = await usdc.balanceOf(secondAccount.address);
			const expectedFee = (MIN_USDC_BET * REFERRER_FEE) / ONE;
			expect(referrerBalAfter - referrerBalBefore).to.equal(expectedFee);
		});

		it('should emit ReferrerPaid on losing spin', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, secondAccount.address);
			const { requestId } = await parseSpinPlaced(slots, tx);

			const expectedFee = (MIN_USDC_BET * REFERRER_FEE) / ONE;
			await expect(vrfCoordinator.fulfillRandomWords(slotsAddress, requestId, [findLossWord()]))
				.to.emit(slots, 'ReferrerPaid')
				.withArgs(secondAccount.address, player.address, expectedFee, MIN_USDC_BET, usdcAddress);
		});

		it('should NOT pay referrer on winning spin', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, secondAccount.address);
			const { requestId } = await parseSpinPlaced(slots, tx);

			const referrerBalBefore = await usdc.balanceOf(secondAccount.address);
			await vrfCoordinator.fulfillRandomWords(slotsAddress, requestId, [findTripleWord(0)]);

			const referrerBalAfter = await usdc.balanceOf(secondAccount.address);
			expect(referrerBalAfter - referrerBalBefore).to.equal(0n);
		});

		it('should NOT pay if no referrer set', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { requestId } = await parseSpinPlaced(slots, tx);

			await expect(vrfCoordinator.fulfillRandomWords(slotsAddress, requestId, [findLossWord()])).to
				.not.be.reverted;
		});

		it('setReferrals should emit event', async () => {
			await expect(slots.connect(owner).setReferrals(secondAccount.address))
				.to.emit(slots, 'ReferralsChanged')
				.withArgs(secondAccount.address);
		});
	});

	/* ========== PAIR PAYOUTS ========== */

	describe('Pair Payouts', () => {
		// Pair payouts for all 5 symbols; all within MAX_PAYOUT_MULTIPLIER (15x)
		const PAIR_PAYOUTS = [
			ethers.parseEther('0.5'),
			ethers.parseEther('0.75'),
			ethers.parseEther('1'),
			ethers.parseEther('1.25'),
			ethers.parseEther('1.75'),
		];

		beforeEach(async () => {
			for (let i = 0; i < SYMBOL_COUNT; i++) {
				await slots.connect(owner).setPairPayout(i, PAIR_PAYOUTS[i]);
			}
		});

		it('setPairPayout should emit event and update state', async () => {
			const mult = ethers.parseEther('2');
			await expect(slots.connect(owner).setPairPayout(0, mult))
				.to.emit(slots, 'PairPayoutChanged')
				.withArgs(0, mult);
			expect(await slots.pairPayout(0)).to.equal(mult);
		});

		it('setPairPayout should revert for symbol >= symbolCount', async () => {
			await expect(
				slots.connect(owner).setPairPayout(SYMBOL_COUNT, ethers.parseEther('1'))
			).to.be.revertedWithCustomError(slots, 'InvalidConfig');
		});

		it('setPairPayout should revert for multiplier > maxPayoutMultiplier', async () => {
			await expect(
				slots.connect(owner).setPairPayout(0, ethers.parseEther('100'))
			).to.be.revertedWithCustomError(slots, 'InvalidConfig');
		});

		it('setPairPayout should revert from non-owner', async () => {
			await expect(slots.connect(secondAccount).setPairPayout(0, ethers.parseEther('1'))).to.be
				.reverted;
		});

		it('should resolve as win on first-two-reels pair (a==b, c!=a)', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { spinId, requestId } = await parseSpinPlaced(slots, tx);

			const playerBalBefore = await usdc.balanceOf(player.address);

			const word = findFirstPairWord(0);
			await vrfCoordinator.fulfillRandomWords(slotsAddress, requestId, [word]);

			const spinDetails = await slots.getSpinDetails(spinId);
			const spinBase = await slots.getSpinBase(spinId);
			expect(spinDetails.won).to.equal(true);

			const rawMult = PAIR_PAYOUTS[0];
			const netMult = (rawMult * (ONE - HOUSE_EDGE)) / ONE;
			const expectedPayout = MIN_USDC_BET + (MIN_USDC_BET * netMult) / ONE;
			expect(spinBase.payout).to.equal(expectedPayout);
			expect(await usdc.balanceOf(player.address)).to.equal(playerBalBefore + expectedPayout);
		});

		it('should resolve as win on last-two-reels pair (a!=b, b==c)', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { spinId, requestId } = await parseSpinPlaced(slots, tx);

			const word = findLastPairWord(2);
			await vrfCoordinator.fulfillRandomWords(slotsAddress, requestId, [word]);

			const spinDetails = await slots.getSpinDetails(spinId);
			const spinBase = await slots.getSpinBase(spinId);
			expect(spinDetails.won).to.equal(true);

			const rawMult = PAIR_PAYOUTS[2];
			const netMult = (rawMult * (ONE - HOUSE_EDGE)) / ONE;
			const expectedPayout = MIN_USDC_BET + (MIN_USDC_BET * netMult) / ONE;
			expect(spinBase.payout).to.equal(expectedPayout);
		});

		it('should NOT pay on non-adjacent pair (a==c, b different)', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { spinId, requestId } = await parseSpinPlaced(slots, tx);

			const word = findACPairWord();
			await vrfCoordinator.fulfillRandomWords(slotsAddress, requestId, [word]);

			const spinDetails = await slots.getSpinDetails(spinId);
			const spinBase = await slots.getSpinBase(spinId);
			expect(spinDetails.won).to.equal(false);
			expect(spinBase.payout).to.equal(0n);
		});

		it('triple supersedes pair payout for the same symbol', async () => {
			// Triple payout for symbol 0 is 2x (from fixture TRIPLE_PAYOUTS); pair payout is 0.5x.
			// A triple should pay the higher (triple) multiplier.
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { spinId, requestId } = await parseSpinPlaced(slots, tx);

			const word = findTripleWord(0);
			await vrfCoordinator.fulfillRandomWords(slotsAddress, requestId, [word]);

			const spinDetails = await slots.getSpinDetails(spinId);
			const spinBase = await slots.getSpinBase(spinId);
			expect(spinDetails.won).to.equal(true);

			const tripleRaw = TRIPLE_PAYOUTS[0]; // 2x
			const netMult = (tripleRaw * (ONE - HOUSE_EDGE)) / ONE;
			const expectedPayout = MIN_USDC_BET + (MIN_USDC_BET * netMult) / ONE;
			expect(spinBase.payout).to.equal(expectedPayout);
			// Sanity: triple payout should be strictly greater than what the pair would've paid
			const pairRaw = PAIR_PAYOUTS[0]; // 0.5x
			const pairNetMult = (pairRaw * (ONE - HOUSE_EDGE)) / ONE;
			const pairWinPayout = MIN_USDC_BET + (MIN_USDC_BET * pairNetMult) / ONE;
			expect(spinBase.payout).to.be.gt(pairWinPayout);
		});

		it('pair with zero payout resolves as loss', async () => {
			// Zero out pair payout for symbol 0
			await slots.connect(owner).setPairPayout(0, 0);

			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { spinId, requestId } = await parseSpinPlaced(slots, tx);

			const word = findFirstPairWord(0);
			await vrfCoordinator.fulfillRandomWords(slotsAddress, requestId, [word]);

			const spinDetails = await slots.getSpinDetails(spinId);
			const spinBase = await slots.getSpinBase(spinId);
			expect(spinDetails.won).to.equal(false);
			expect(spinBase.payout).to.equal(0n);
		});

		it('setMaxPayoutMultiplier should revert when below existing pairPayout', async () => {
			// Set pair payout for symbol 4 to 12 (still <= MAX_PAYOUT_MULTIPLIER 15)
			await slots.connect(owner).setPairPayout(4, ethers.parseEther('12'));
			// Now lowering maxPayoutMultiplier to 10 should revert because pairPayout[4] = 12
			await expect(
				slots.connect(owner).setMaxPayoutMultiplier(ethers.parseEther('10'))
			).to.be.revertedWithCustomError(slots, 'InvalidConfig');
		});

		it('pair win should NOT pay referrer (referrer only paid on loss)', async () => {
			const MockReferralsFactory = await ethers.getContractFactory('MockReferrals');
			const mockReferrals = await MockReferralsFactory.deploy();
			await mockReferrals.setReferrerFees(
				ethers.parseEther('0.005'),
				ethers.parseEther('0.005'),
				ethers.parseEther('0.005')
			);
			await slots.setReferrals(await mockReferrals.getAddress());

			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET, secondAccount.address);
			const { requestId } = await parseSpinPlaced(slots, tx);

			const referrerBalBefore = await usdc.balanceOf(secondAccount.address);
			await vrfCoordinator.fulfillRandomWords(slotsAddress, requestId, [findFirstPairWord(0)]);
			const referrerBalAfter = await usdc.balanceOf(secondAccount.address);
			expect(referrerBalAfter - referrerBalBefore).to.equal(0n);
		});
	});
});
