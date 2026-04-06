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

// Helper: derive reel result from a random word segment
function rollSymbol(r) {
	const rand = r % TOTAL_WEIGHT;
	let acc = 0n;
	for (let i = 0; i < SYMBOL_COUNT; i++) {
		acc += SYMBOL_WEIGHTS[i];
		if (rand < acc) return i;
	}
	return 0;
}

// Helper: derive all 3 reels from a random word
function deriveReels(word) {
	const r1 = rollSymbol(word);
	const r2 = rollSymbol(word >> 16n);
	const r3 = rollSymbol(word >> 32n);
	return [r1, r2, r3];
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

// Helper: construct a random word that gives triple of a specific symbol
// With equal weights of 20 and total 100: symbol s wins when rand in [20*s, 20*(s+1))
// Due to the property that 65536 % 100 = 36, and s*20*36 % 100 = s*20,
// placing s*20 in the top 32-bit segment naturally propagates to all reels
function findTripleWord(symbol) {
	const targetRand = BigInt(symbol) * 20n;
	const word = targetRand * 2n ** 32n;
	// Verify
	const [r1, r2, r3] = deriveReels(word);
	if (r1 !== symbol || r2 !== symbol || r3 !== symbol) {
		throw new Error(
			`Triple word verification failed for symbol ${symbol}: got [${r1},${r2},${r3}]`
		);
	}
	return word;
}

// Helper: find a random word that gives no triple
// r=20 → reel1=symbol1, reel2=symbol0, reel3=symbol0 → not a triple
function findLossWord() {
	const word = 20n;
	const [r1, r2, r3] = deriveReels(word);
	if (r1 === r2 && r2 === r3) {
		throw new Error('Loss word verification failed');
	}
	return word;
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
	let slots, slotsAddress, usdc, usdcAddress, vrfCoordinator;
	let owner, secondAccount, resolver, riskManager, pauser, player;

	beforeEach(async () => {
		({
			slots,
			slotsAddress,
			usdc,
			usdcAddress,
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
				slots.connect(player).spin(secondAccount.address, MIN_USDC_BET)
			).to.be.revertedWithCustomError(slots, 'InvalidCollateral');
		});

		it('should revert for zero amount', async () => {
			await expect(slots.connect(player).spin(usdcAddress, 0)).to.be.revertedWithCustomError(
				slots,
				'InvalidAmount'
			);
		});

		it('should revert for below min bet', async () => {
			await usdc.connect(player).approve(slotsAddress, 1n);
			await expect(slots.connect(player).spin(usdcAddress, 1n)).to.be.revertedWithCustomError(
				slots,
				'InvalidAmount'
			);
		});

		it('should revert when paused', async () => {
			await slots.connect(pauser).setPausedByRole(true);
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			await expect(slots.connect(player).spin(usdcAddress, MIN_USDC_BET)).to.be.reverted;
		});

		it('should place a spin and emit SpinPlaced', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			await expect(slots.connect(player).spin(usdcAddress, MIN_USDC_BET))
				.to.emit(slots, 'SpinPlaced')
				.withArgs(1n, 1n, player.address, usdcAddress, MIN_USDC_BET);

			const spin = await slots.spins(1n);
			expect(spin.user).to.equal(player.address);
			expect(spin.status).to.equal(Status.PENDING);
			expect(await slots.nextSpinId()).to.equal(2n);
		});

		it('should transfer collateral from player', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const balBefore = await usdc.balanceOf(player.address);
			await slots.connect(player).spin(usdcAddress, MIN_USDC_BET);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore - MIN_USDC_BET);
		});

		it('should reserve profit', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			await slots.connect(player).spin(usdcAddress, MIN_USDC_BET);
			const reserved = await slots.reservedProfitPerCollateral(usdcAddress);
			const expectedReserved = (MIN_USDC_BET * MAX_PAYOUT_MULTIPLIER) / ONE;
			expect(reserved).to.equal(expectedReserved);
		});
	});

	/* ========== VRF RESOLUTION ========== */

	describe('Resolution', () => {
		it('should resolve as win on triple match (symbol 0)', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET);
			const { spinId, requestId } = await parseSpinPlaced(slots, tx);

			const playerBalBefore = await usdc.balanceOf(player.address);

			const tripleWord = findTripleWord(0);
			await vrfCoordinator.fulfillRandomWords(slotsAddress, requestId, [tripleWord]);

			const spin = await slots.spins(spinId);
			expect(spin.status).to.equal(Status.RESOLVED);
			expect(spin.won).to.equal(true);

			const expectedPayout = getExpectedPayout(MIN_USDC_BET, tripleWord);
			expect(spin.payout).to.equal(expectedPayout);
			expect(expectedPayout).to.be.gt(0n);
			expect(await usdc.balanceOf(player.address)).to.equal(playerBalBefore + expectedPayout);
		});

		it('should resolve as win on jackpot triple (symbol 4)', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET);
			const { spinId, requestId } = await parseSpinPlaced(slots, tx);

			const tripleWord = findTripleWord(4);
			await vrfCoordinator.fulfillRandomWords(slotsAddress, requestId, [tripleWord]);

			const spin = await slots.spins(spinId);
			expect(spin.won).to.equal(true);

			const expectedPayout = getExpectedPayout(MIN_USDC_BET, tripleWord);
			expect(spin.payout).to.equal(expectedPayout);
		});

		it('should resolve as loss on non-matching reels', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET);
			const { spinId, requestId } = await parseSpinPlaced(slots, tx);

			const lossWord = findLossWord();
			await vrfCoordinator.fulfillRandomWords(slotsAddress, requestId, [lossWord]);

			const spin = await slots.spins(spinId);
			expect(spin.status).to.equal(Status.RESOLVED);
			expect(spin.won).to.equal(false);
			expect(spin.payout).to.equal(0n);
		});

		it('should release reserved profit on resolution', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET);
			const { requestId } = await parseSpinPlaced(slots, tx);

			const reservedBefore = await slots.reservedProfitPerCollateral(usdcAddress);
			expect(reservedBefore).to.be.gt(0n);

			await vrfCoordinator.fulfillRandomWords(slotsAddress, requestId, [findLossWord()]);

			expect(await slots.reservedProfitPerCollateral(usdcAddress)).to.equal(0n);
		});

		it('should emit SpinResolved event', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET);
			const { requestId } = await parseSpinPlaced(slots, tx);

			await expect(
				vrfCoordinator.fulfillRandomWords(slotsAddress, requestId, [findLossWord()])
			).to.emit(slots, 'SpinResolved');
		});

		it('should not resolve already resolved spin', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET);
			const { spinId, requestId } = await parseSpinPlaced(slots, tx);

			await vrfCoordinator.fulfillRandomWords(slotsAddress, requestId, [findLossWord()]);

			// Second fulfillment should be no-op
			await vrfCoordinator.fulfillRandomWords(slotsAddress, requestId, [findTripleWord(4)]);

			const spin = await slots.spins(spinId);
			expect(spin.won).to.equal(false); // still loss from first resolution
		});
	});

	/* ========== CANCEL ========== */

	describe('cancelSpin', () => {
		it('should revert if timeout not reached', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET);
			const { spinId } = await parseSpinPlaced(slots, tx);

			await expect(slots.connect(player).cancelSpin(spinId)).to.be.revertedWithCustomError(
				slots,
				'CancelTimeoutNotReached'
			);
		});

		it('should revert if not spin owner', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET);
			const { spinId } = await parseSpinPlaced(slots, tx);

			await time.increase(CANCEL_TIMEOUT);
			await expect(slots.connect(secondAccount).cancelSpin(spinId)).to.be.revertedWithCustomError(
				slots,
				'SpinNotOwner'
			);
		});

		it('should cancel after timeout and refund', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET);
			const { spinId } = await parseSpinPlaced(slots, tx);

			const balBefore = await usdc.balanceOf(player.address);
			await time.increase(CANCEL_TIMEOUT);

			await expect(slots.connect(player).cancelSpin(spinId)).to.emit(slots, 'SpinCancelled');

			expect(await usdc.balanceOf(player.address)).to.equal(balBefore + MIN_USDC_BET);
			const spin = await slots.spins(spinId);
			expect(spin.status).to.equal(Status.CANCELLED);
			expect(spin.payout).to.equal(MIN_USDC_BET);
		});

		it('should release reserved profit on cancel', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET);
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
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET);
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
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET);
			const { spinId } = await parseSpinPlaced(slots, tx);

			await expect(
				slots.connect(secondAccount).adminCancelSpin(spinId)
			).to.be.revertedWithCustomError(slots, 'InvalidSender');
		});

		it('should allow owner to admin cancel', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET);
			const { spinId } = await parseSpinPlaced(slots, tx);

			await expect(slots.connect(owner).adminCancelSpin(spinId)).to.emit(slots, 'SpinCancelled');
		});

		it('should allow resolver to admin cancel', async () => {
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			const tx = await slots.connect(player).spin(usdcAddress, MIN_USDC_BET);
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

	/* ========== GETTERS ========== */

	describe('Getters', () => {
		it('getAvailableLiquidity should return bankroll minus reserved', async () => {
			expect(await slots.getAvailableLiquidity(usdcAddress)).to.equal(59n * 1_000_000n);
		});

		it('getAvailableLiquidity should decrease after spin', async () => {
			const before = await slots.getAvailableLiquidity(usdcAddress);
			await usdc.connect(player).approve(slotsAddress, MIN_USDC_BET);
			await slots.connect(player).spin(usdcAddress, MIN_USDC_BET);
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
});
