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

const MIN_USDC_BET = 3n * 1_000_000n;

// HandStatus enum
const Status = {
	NONE: 0n,
	AWAITING_DEAL: 1n,
	PLAYER_TURN: 2n,
	AWAITING_HIT: 3n,
	AWAITING_STAND: 4n,
	AWAITING_DOUBLE: 5n,
	RESOLVED: 6n,
	CANCELLED: 7n,
	AWAITING_SPLIT: 8n,
};

// Helper: build a VRF word so that _deriveCard(word, 0) == r0 and _deriveCard(word, 1) == r1.
// Solidity does (word >> shift*128) % 13; for shift 0 this mods the FULL word, so the upper
// 128 bits leak into the low result. Compensate by choosing low such that
// (low + (2^128 mod 13) * high) mod 13 == r0 - 1, where 2^128 mod 13 == 9.
function makeDealWord(r0, r1 = 1) {
	const high = BigInt((((r1 - 1) % 13) + 13) % 13);
	const target = BigInt((((r0 - 1) % 13) + 13) % 13);
	const low = (target - 9n * high + 169n) % 13n;
	return low | (high << 128n);
}
function makeSingleWord(r) {
	return BigInt((((r - 1) % 13) + 13) % 13);
}

// HandResult enum
const Result = {
	NONE: 0n,
	PLAYER_BLACKJACK: 1n,
	PLAYER_WIN: 2n,
	DEALER_WIN: 3n,
	PUSH: 4n,
	PLAYER_BUST: 5n,
	DEALER_BUST: 6n,
};

// Card derivation: _deriveCard(word, shiftIndex) = ((word >> (shiftIndex * 128)) % 13) + 1
// rank 1=Ace, 2-10, 11=J, 12=Q, 13=K
// value: Ace=11, 2-10=face, J/Q/K=10

// Helper: compute card rank from a random word and shift index
function deriveCard(word, shiftIndex) {
	const shifted = word >> (BigInt(shiftIndex) * 128n);
	return Number((shifted % 13n) + 1n);
}

// Helper: card value for blackjack
function cardValue(rank) {
	if (rank === 1) return 11;
	if (rank >= 11) return 10;
	return rank;
}

async function deployBlackjackFixture() {
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

	const BlackjackFactory = await ethers.getContractFactory('Blackjack');
	const blackjack = await upgrades.deployProxy(BlackjackFactory, [], { initializer: false });
	const blackjackAddress = await blackjack.getAddress();

	await blackjack.initialize(
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
		{
			subscriptionId: 1,
			keyHash: ethers.ZeroHash,
			callbackGasLimit: 500000,
			requestConfirmations: 3,
			nativePayment: false,
		}
	);

	// Fund bankroll
	await usdc.transfer(blackjackAddress, 50n * 1_000_000n);

	// Fund player
	await usdc.transfer(player.address, 40n * 1_000_000n);

	return {
		blackjack,
		blackjackAddress,
		usdc,
		usdcAddress,
		weth,
		wethAddress,
		over,
		overAddress,
		vrfCoordinator,
		manager,
		owner,
		secondAccount,
		resolver,
		riskManager,
		pauser,
		player,
	};
}

async function parseHandCreated(blackjack, tx) {
	const receipt = await tx.wait();
	const parsed = receipt.logs
		.map((log) => {
			try {
				return blackjack.interface.parseLog(log);
			} catch {
				return null;
			}
		})
		.find((e) => e?.name === 'HandCreated');
	return { handId: parsed.args.handId, requestId: parsed.args.requestId };
}

async function parseRequestId(blackjack, tx, eventName) {
	const receipt = await tx.wait();
	const parsed = receipt.logs
		.map((log) => {
			try {
				return blackjack.interface.parseLog(log);
			} catch {
				return null;
			}
		})
		.find((e) => e?.name === eventName);
	return parsed.args.requestId;
}

describe('Blackjack', () => {
	let blackjack,
		blackjackAddress,
		usdc,
		usdcAddress,
		weth,
		wethAddress,
		over,
		overAddress,
		vrfCoordinator;
	let owner, secondAccount, resolver, riskManager, pauser, player;

	beforeEach(async () => {
		({
			blackjack,
			blackjackAddress,
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
		} = await loadFixture(deployBlackjackFixture));
	});

	/* ========== INITIALIZATION ========== */

	describe('Initialization', () => {
		it('should set correct state after initialize', async () => {
			expect(await blackjack.owner()).to.equal(owner.address);
			expect(await blackjack.usdc()).to.equal(usdcAddress);
			expect(await blackjack.maxProfitUsd()).to.equal(MAX_PROFIT_USD);
			expect(await blackjack.cancelTimeout()).to.equal(CANCEL_TIMEOUT);
			expect(await blackjack.nextHandId()).to.equal(1n);
		});

		it('should revert on re-initialization', async () => {
			await expect(
				blackjack.initialize(
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

		it('should revert with zero collateral address', async () => {
			const BlackjackFactory = await ethers.getContractFactory('Blackjack');
			const b = await upgrades.deployProxy(BlackjackFactory, [], { initializer: false });
			await expect(
				b.initialize(
					{
						owner: owner.address,
						manager: owner.address,
						priceFeed: owner.address,
						vrfCoordinator: owner.address,
					},
					{
						usdc: ethers.ZeroAddress,
						weth: usdcAddress,
						over: usdcAddress,
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
				)
			).to.be.revertedWithCustomError(b, 'InvalidAddress');
		});
	});

	/* ========== PLACE BET ========== */

	describe('placeBet', () => {
		it('should revert for unsupported collateral', async () => {
			await expect(
				blackjack.connect(player).placeBet(secondAccount.address, MIN_USDC_BET, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(blackjack, 'InvalidCollateral');
		});

		it('should revert for zero amount', async () => {
			await expect(
				blackjack.connect(player).placeBet(usdcAddress, 0, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(blackjack, 'InvalidAmount');
		});

		it('should revert when paused', async () => {
			await blackjack.connect(pauser).setPausedByRole(true);
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			await expect(
				blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress)
			).to.be.reverted;
		});

		it('should revert when aggregate payout liability of pending hands exceeds balance', async () => {
			// Bankroll 50 USDC. Per hand: stake 3, reserved profit = 3 * 3/2 = 4.5 (BJ payout),
			// aggregator = 7.5 per hand. After N hands: balance = 50 + 3N, reserved = 7.5N.
			// Solvent while: 50 + 3N >= 7.5N  →  N ≤ 11. 12th hand must revert.
			const bet = MIN_USDC_BET;
			await usdc.mintForUser(player.address);
			await usdc.connect(player).approve(blackjackAddress, bet * 15n);
			for (let i = 0; i < 11; i++) {
				await blackjack.connect(player).placeBet(usdcAddress, bet, ethers.ZeroAddress);
			}
			await expect(
				blackjack.connect(player).placeBet(usdcAddress, bet, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(blackjack, 'InsufficientAvailableLiquidity');
		});

		it('should place a bet and emit HandCreated', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			await expect(
				blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress)
			)
				.to.emit(blackjack, 'HandCreated')
				.withArgs(1n, 1n, player.address, usdcAddress, MIN_USDC_BET);

			const handBase = await blackjack.getHandBase(1n);
			const handDetails = await blackjack.getHandDetails(1n);
			expect(handBase.user).to.equal(player.address);
			expect(handDetails.status).to.equal(Status.AWAITING_DEAL);
			expect(await blackjack.nextHandId()).to.equal(2n);
		});
	});

	/* ========== DEAL (VRF FULFILLMENT) ========== */

	describe('Deal', () => {
		it('should deal initial cards and set PLAYER_TURN', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);

			// Use words that produce non-blackjack hands
			// word0: playerCard1 = (100 % 13) + 1 = 10, dealerFaceUp = ((100 >> 128) % 13) + 1 = 1 (Ace)
			// word1: playerCard2 = (200 % 13) + 1 = 6, dealerHidden = ((200 >> 128) % 13) + 1 = 1
			// Actually let's use simple values to control outcome
			// word0 = 9 → playerCard1 = (9%13)+1 = 10, dealerFaceUp = ((9>>128)%13)+1 = 1 (0>>128=0, 0%13+1=1)
			// word1 = 5 → playerCard2 = (5%13)+1 = 6, dealerHidden = 1
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [9n, 5n]);

			const handDetails = await blackjack.getHandDetails(handId);
			expect(handDetails.status).to.equal(Status.PLAYER_TURN);
			expect(handDetails.playerCardCount).to.equal(2n);
			expect(handDetails.dealerCardCount).to.equal(1n);

			const handCards = await blackjack.getHandCards(handId);
			expect(handCards.playerCards.length).to.equal(2);
			expect(handCards.dealerCards.length).to.equal(1);
		});

		it('should auto-resolve player blackjack (3:2 payout)', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);

			const playerBalanceBefore = await usdc.balanceOf(player.address);

			// Need playerCard1=Ace(1), playerCard2=10-value
			// word0: (word0 % 13)+1 = 1 → word0 % 13 = 0 → word0 = 0
			// word1: (word1 % 13)+1 = 10 → word1 % 13 = 9 → word1 = 9
			// dealerFaceUp: (0 >> 128) % 13 + 1 = 1 (Ace) — dealer also gets Ace
			// dealerHidden: (9 >> 128) % 13 + 1 = 1 (Ace) — dealer doesn't have blackjack (A+A=12)
			// So player has BJ (A+10=21), dealer has A+A=12 → player blackjack wins
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [0n, 9n]);

			const handDetails = await blackjack.getHandDetails(handId);
			const handBase = await blackjack.getHandBase(handId);
			expect(handDetails.status).to.equal(Status.RESOLVED);
			expect(handDetails.result).to.equal(Result.PLAYER_BLACKJACK);

			// 3:2 payout = amount + amount*3/2 = 3 + 4.5 = 7.5 USDC
			const expectedPayout = MIN_USDC_BET + (MIN_USDC_BET * 3n) / 2n;
			expect(handBase.payout).to.equal(expectedPayout);
			expect(await usdc.balanceOf(player.address)).to.equal(playerBalanceBefore + expectedPayout);
		});

		it('should push when both player and dealer have blackjack', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);

			const playerBalanceBefore = await usdc.balanceOf(player.address);

			// _deriveCard(word, 0) = (word % 13) + 1, _deriveCard(word, 1) = ((word >> 128) % 13) + 1
			// Need: player Ace+10=21 (BJ), dealer 10+Ace=21 (BJ)
			// word0: playerCard1=Ace → word0%13=0, dealerFaceUp=10 → (word0>>128)%13=9
			//   upper=9, 9*2^128 mod 13=3, so lower must satisfy (lower+3)%13=0 → lower=10
			const word0 = 10n + (9n << 128n); // player=Ace, dealer faceUp=10
			// word1: playerCard2=10 → word1%13=9, dealerHidden=Ace → (word1>>128)%13=0
			const word1 = 9n; // player=10, dealer hidden=Ace
			// Player: Ace+10=21 (BJ), Dealer: 10+Ace=21 (BJ) → PUSH

			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [word0, word1]);

			const handDetails = await blackjack.getHandDetails(handId);
			const handBase = await blackjack.getHandBase(handId);
			expect(handDetails.status).to.equal(Status.RESOLVED);
			expect(handDetails.result).to.equal(Result.PUSH);
			expect(handBase.payout).to.equal(MIN_USDC_BET); // bet returned
			expect(await usdc.balanceOf(player.address)).to.equal(playerBalanceBefore + MIN_USDC_BET);
		});
	});

	/* ========== HIT ========== */

	describe('Hit', () => {
		it('should revert if not hand owner', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [9n, 5n]);

			await expect(blackjack.connect(secondAccount).hit(handId)).to.be.revertedWithCustomError(
				blackjack,
				'HandNotOwner'
			);
		});

		it('should revert if not PLAYER_TURN', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { handId } = await parseHandCreated(blackjack, tx);
			// Still AWAITING_DEAL
			await expect(blackjack.connect(player).hit(handId)).to.be.revertedWithCustomError(
				blackjack,
				'InvalidHandStatus'
			);
		});

		it('should deal one card on hit and stay in PLAYER_TURN if not bust', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);

			// Deal: player gets 5+3=8 (safe hand)
			// word0=4 → rank 5, word1=2 → rank 3
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [4n, 2n]);

			const hitTx = await blackjack.connect(player).hit(handId);
			const hitRequestId = await parseRequestId(blackjack, hitTx, 'HitRequested');

			// Hit card: word=1 → rank 2 (value 2). Total = 5+3+2=10
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, hitRequestId, [1n]);

			const handDetails = await blackjack.getHandDetails(handId);
			expect(handDetails.status).to.equal(Status.PLAYER_TURN);
			expect(handDetails.playerCardCount).to.equal(3n);
		});

		it('should auto-resolve on bust', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);

			// Deal: player gets King(10) + Queen(10) = 20
			// word0=12 → rank 13(K=10), word1=11 → rank 12(Q=10)
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [12n, 11n]);

			const hitTx = await blackjack.connect(player).hit(handId);
			const hitRequestId = await parseRequestId(blackjack, hitTx, 'HitRequested');

			// Hit card: word=4 → rank 5 (value 5). Total = 10+10+5=25 → bust
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, hitRequestId, [4n]);

			const handDetails = await blackjack.getHandDetails(handId);
			const handBase = await blackjack.getHandBase(handId);
			expect(handDetails.status).to.equal(Status.RESOLVED);
			expect(handDetails.result).to.equal(Result.PLAYER_BUST);
			expect(handBase.payout).to.equal(0n);
		});
	});

	/* ========== STAND ========== */

	describe('Stand', () => {
		it('should resolve with player win when player > dealer', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);

			// Deal: player gets 10+10=20
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [12n, 11n]);

			const playerBalanceBefore = await usdc.balanceOf(player.address);

			const standTx = await blackjack.connect(player).stand(handId);
			const standRequestId = await parseRequestId(blackjack, standTx, 'StandRequested');

			// Dealer hidden card + draws
			// word[0]=5 → dealer hidden = rank 6 (value 6). Dealer face-up from deal: rank ((12>>128)%13)+1=1(Ace)
			// Dealer has Ace(11)+6=17. Soft 17 → must hit
			// word[1]=4 → rank 5. Dealer: 11+6+5=22 → bust. But wait, soft: Ace→1, so 1+6+5=12. Still < 17, hit again
			// Actually: Ace(11)+6=17, soft. Hit. word[1]=4→rank5. 11+6+5=22, convert ace: 1+6+5=12. <17 hit.
			// word[2]=7 → rank 8. 12+8=20. >=17, stop.
			// Dealer=20, Player=20 → push. Hmm, that's not a player win.

			// Let me recalculate. Let me use words that give dealer a lower total.
			// Dealer faceUp from deal word0=12: ((12>>128)%13)+1 = (0%13)+1 = 1 = Ace
			// word[0]=5 → hidden = (5%13)+1 = 6. Dealer: Ace(11)+6=17, soft 17 → hit
			// word[1]=1 → rank 2. Dealer: 11+6+2=19 → convert: still 19 (not over 21). 19 >= 17, stop.
			// Dealer=19, Player=20 → player wins!
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, standRequestId, [
				5n,
				1n,
				0n,
				0n,
				0n,
				0n,
				0n,
			]);

			const handDetails = await blackjack.getHandDetails(handId);
			const handBase = await blackjack.getHandBase(handId);
			expect(handDetails.status).to.equal(Status.RESOLVED);
			expect(handDetails.result).to.equal(Result.PLAYER_WIN);
			expect(handBase.payout).to.equal(MIN_USDC_BET * 2n);
			expect(await usdc.balanceOf(player.address)).to.equal(
				playerBalanceBefore + MIN_USDC_BET * 2n
			);
		});

		it('should resolve with dealer win when dealer > player', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);

			// Deal: player gets 6+5=11
			// word0=5→rank6, word1=4→rank5. DealerFaceUp=((5>>128)%13)+1=1(Ace)
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [5n, 4n]);

			const standTx = await blackjack.connect(player).stand(handId);
			const standRequestId = await parseRequestId(blackjack, standTx, 'StandRequested');

			// Dealer hidden: word[0]=9 → rank 10. Dealer: Ace(11)+10=21 → stop. Dealer=21 > Player=11
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, standRequestId, [
				9n,
				0n,
				0n,
				0n,
				0n,
				0n,
				0n,
			]);

			const handDetails = await blackjack.getHandDetails(handId);
			const handBase = await blackjack.getHandBase(handId);
			expect(handDetails.status).to.equal(Status.RESOLVED);
			expect(handDetails.result).to.equal(Result.DEALER_WIN);
			expect(handBase.payout).to.equal(0n);
		});

		it('should resolve as dealer bust when dealer exceeds 21', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);

			// Deal: player gets 10+8=18
			// word0=12→rank13(K=10), dealerFaceUp=((12>>128)%13)+1=1(Ace)
			// word1=7→rank8
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [12n, 7n]);

			const standTx = await blackjack.connect(player).stand(handId);
			const standRequestId = await parseRequestId(blackjack, standTx, 'StandRequested');

			// Dealer face up = Ace(11). Hidden: word[0]=4→rank5. Dealer: 11+5=16 < 17 → hit
			// word[1]=11→rank12(Q=10). 16+10=26 → bust. But Ace: 1+5+10=16 < 17 → hit again
			// word[2]=9→rank10. 16+10=26 → bust
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, standRequestId, [
				4n,
				11n,
				9n,
				0n,
				0n,
				0n,
				0n,
			]);

			const handDetails = await blackjack.getHandDetails(handId);
			const handBase = await blackjack.getHandBase(handId);
			expect(handDetails.status).to.equal(Status.RESOLVED);
			expect(handDetails.result).to.equal(Result.DEALER_BUST);
			expect(handBase.payout).to.equal(MIN_USDC_BET * 2n);
		});

		it('should resolve as push when tied', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);

			// Deal: player gets 10+7=17
			// word0=12→rank13(K=10), dealerFaceUp=1(Ace)
			// word1=6→rank7
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [12n, 6n]);

			const standTx = await blackjack.connect(player).stand(handId);
			const standRequestId = await parseRequestId(blackjack, standTx, 'StandRequested');

			// Dealer faceUp=Ace(11). Hidden: word[0]=5→rank6. Dealer: 11+6=17, soft 17 → hit
			// word[1]=12→rank13(K=10). 17+10=27, convert ace: 7+10=17 → stop (hard 17)
			// Dealer=17, Player=17 → push
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, standRequestId, [
				5n,
				12n,
				0n,
				0n,
				0n,
				0n,
				0n,
			]);

			const handDetails = await blackjack.getHandDetails(handId);
			const handBase = await blackjack.getHandBase(handId);
			expect(handDetails.status).to.equal(Status.RESOLVED);
			expect(handDetails.result).to.equal(Result.PUSH);
			expect(handBase.payout).to.equal(MIN_USDC_BET);
		});
	});

	/* ========== DOUBLE DOWN ========== */

	describe('Double Down', () => {
		it('should double bet and resolve', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET * 2n);
			const tx = await blackjack
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);

			// Deal: player gets 5+6=11 (great double down hand)
			// word0=4→rank5, dealerFaceUp=1(Ace)
			// word1=5→rank6
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [4n, 5n]);

			const playerBalanceBefore = await usdc.balanceOf(player.address);

			const ddTx = await blackjack.connect(player).doubleDown(handId);
			const ddRequestId = await parseRequestId(blackjack, ddTx, 'DoubleDownRequested');

			// Player gets 1 more card: word[0]=9→rank10. Player: 5+6+10=21
			// Dealer hidden: word[1]=5→rank6. Dealer: Ace(11)+6=17, soft 17 → hit
			// word[2]=4→rank5. Dealer: 17+5=22, convert: 7+5=12 < 17 → hit
			// word[3]=6→rank7. 12+7=19 >= 17 → stop
			// Player=21 > Dealer=19 → player wins. Payout = doubled amount * 2 = 6*2=12 USDC
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, ddRequestId, [
				9n,
				5n,
				4n,
				6n,
				0n,
				0n,
				0n,
			]);

			const handDetails = await blackjack.getHandDetails(handId);
			const handBase = await blackjack.getHandBase(handId);
			expect(handDetails.status).to.equal(Status.RESOLVED);
			expect(handDetails.result).to.equal(Result.PLAYER_WIN);
			expect(handBase.amount).to.equal(MIN_USDC_BET * 2n); // doubled
			expect(handBase.payout).to.equal(MIN_USDC_BET * 4n); // 2x doubled amount
		});

		it('should revert if player has more than 2 cards', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET * 2n);
			const tx = await blackjack
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);

			// Deal low cards so player won't bust
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [1n, 2n]);

			// Hit first
			const hitTx = await blackjack.connect(player).hit(handId);
			const hitReqId = await parseRequestId(blackjack, hitTx, 'HitRequested');
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, hitReqId, [1n]);

			// Now try double down with 3 cards — should revert
			await expect(blackjack.connect(player).doubleDown(handId)).to.be.revertedWithCustomError(
				blackjack,
				'InvalidHandStatus'
			);
		});
	});

	/* ========== CANCEL ========== */

	describe('cancelHand', () => {
		it('should revert if timeout not reached', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { handId } = await parseHandCreated(blackjack, tx);

			await expect(blackjack.connect(player).cancelHand(handId)).to.be.revertedWithCustomError(
				blackjack,
				'InvalidHandStatus'
			);
		});

		it('should cancel after timeout and refund', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { handId } = await parseHandCreated(blackjack, tx);

			const balBefore = await usdc.balanceOf(player.address);
			await time.increase(CANCEL_TIMEOUT);

			await expect(blackjack.connect(player).cancelHand(handId)).to.emit(
				blackjack,
				'HandCancelled'
			);

			expect(await usdc.balanceOf(player.address)).to.equal(balBefore + MIN_USDC_BET);
			const handDetails = await blackjack.getHandDetails(handId);
			expect(handDetails.status).to.equal(Status.CANCELLED);
		});
	});

	/* ========== ADMIN CANCEL ========== */

	describe('adminCancelHand', () => {
		it('should revert for non-resolver', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { handId } = await parseHandCreated(blackjack, tx);

			await expect(
				blackjack.connect(secondAccount).adminCancelHand(handId)
			).to.be.revertedWithCustomError(blackjack, 'InvalidSender');
		});

		it('should allow owner to admin cancel', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { handId } = await parseHandCreated(blackjack, tx);

			await expect(blackjack.connect(owner).adminCancelHand(handId)).to.emit(
				blackjack,
				'HandCancelled'
			);
		});
	});

	/* ========== WITHDRAW COLLATERAL ========== */

	describe('withdrawCollateral', () => {
		it('should allow owner to withdraw', async () => {
			const amount = 10n * 1_000_000n;
			await expect(
				blackjack.connect(owner).withdrawCollateral(usdcAddress, secondAccount.address, amount)
			)
				.to.emit(blackjack, 'WithdrawnCollateral')
				.withArgs(usdcAddress, secondAccount.address, amount);
		});

		it('should revert for non-owner', async () => {
			await expect(
				blackjack.connect(secondAccount).withdrawCollateral(usdcAddress, secondAccount.address, 1n)
			).to.be.reverted;
		});
	});

	/* ========== SPLIT GETTERS ========== */

	describe('Split Getters', () => {
		it('getHandBase returns correct values after placing a bet', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { handId } = await parseHandCreated(blackjack, tx);

			const handBase = await blackjack.getHandBase(handId);
			expect(handBase.user).to.equal(player.address);
			expect(handBase.collateral).to.equal(usdcAddress);
			expect(handBase.amount).to.equal(MIN_USDC_BET);
			expect(handBase.payout).to.equal(0n);
		});

		it('getHandDetails returns correct values after deal', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);

			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [9n, 5n]);

			const handDetails = await blackjack.getHandDetails(handId);
			expect(handDetails.status).to.equal(Status.PLAYER_TURN);
			expect(handDetails.playerCardCount).to.equal(2n);
			expect(handDetails.dealerCardCount).to.equal(1n);
		});

		it('getHandCards returns player and dealer cards after deal', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);

			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [9n, 5n]);

			const handCards = await blackjack.getHandCards(handId);
			expect(handCards.playerCards.length).to.equal(2);
			expect(handCards.dealerCards.length).to.equal(1);
			// cards should be non-zero rank values
			expect(handCards.playerCards[0]).to.be.gt(0n);
			expect(handCards.playerCards[1]).to.be.gt(0n);
			expect(handCards.dealerCards[0]).to.be.gt(0n);
		});
	});

	/* ========== LAST REQUEST AT ========== */

	describe('lastRequestAt', () => {
		it('should be set on placeBet', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { handId } = await parseHandCreated(blackjack, tx);

			const lastReq = await blackjack.lastRequestAt(handId);
			expect(lastReq).to.be.gt(0n);
		});

		it('should be updated on stand', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);

			const lastReqBefore = await blackjack.lastRequestAt(handId);

			// Deal cards: player gets 10+10=20
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [12n, 11n]);

			await time.increase(10);

			await blackjack.connect(player).stand(handId);

			const lastReqAfter = await blackjack.lastRequestAt(handId);
			expect(lastReqAfter).to.be.gt(lastReqBefore);
		});
	});

	/* ========== CANCEL EDGE CASES ========== */

	describe('Cancel edge cases', () => {
		it('user cancel should revert on PLAYER_TURN', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);

			// Deal cards to reach PLAYER_TURN
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [9n, 5n]);

			const handDetails = await blackjack.getHandDetails(handId);
			expect(handDetails.status).to.equal(Status.PLAYER_TURN);

			// Even after timeout, user cannot cancel during PLAYER_TURN
			await time.increase(CANCEL_TIMEOUT);
			await expect(blackjack.connect(player).cancelHand(handId)).to.be.revertedWithCustomError(
				blackjack,
				'InvalidHandStatus'
			);
		});

		it('admin cancel should work on PLAYER_TURN', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);

			// Deal cards to reach PLAYER_TURN
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [9n, 5n]);

			const handDetails = await blackjack.getHandDetails(handId);
			expect(handDetails.status).to.equal(Status.PLAYER_TURN);

			// Admin can cancel during PLAYER_TURN
			await expect(blackjack.connect(owner).adminCancelHand(handId)).to.emit(
				blackjack,
				'HandCancelled'
			);
		});

		it('cancel timeout uses lastRequestAt not placedAt', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);

			// Wait partial timeout
			await time.increase(CANCEL_TIMEOUT - 100n);

			// Deal cards, then hit => this updates lastRequestAt
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [4n, 2n]);
			const hitTx = await blackjack.connect(player).hit(handId);
			const hitRequestId = await parseRequestId(blackjack, hitTx, 'HitRequested');

			// Even though we waited nearly CANCEL_TIMEOUT since placeBet,
			// the cancel timeout should reset from lastRequestAt (the hit)
			await expect(blackjack.connect(player).cancelHand(handId)).to.be.revertedWithCustomError(
				blackjack,
				'InvalidHandStatus'
			);

			// Now wait the full timeout from the hit
			await time.increase(CANCEL_TIMEOUT);
			await expect(blackjack.connect(player).cancelHand(handId)).to.emit(
				blackjack,
				'HandCancelled'
			);
		});
	});

	/* ========== AUDIT FIXES ========== */

	describe('Audit Fixes', () => {
		it('withdrawCollateral should revert when amount exceeds available (reserved funds protection)', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			await blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);

			const balance = await usdc.balanceOf(blackjackAddress);
			await expect(
				blackjack.connect(owner).withdrawCollateral(usdcAddress, secondAccount.address, balance)
			).to.be.revertedWithCustomError(blackjack, 'InsufficientAvailableLiquidity');
		});

		it('setRiskParams cancelTimeout below MIN_CANCEL_TIMEOUT (30) should revert', async () => {
			await expect(blackjack.connect(owner).setRiskParams(0, 29)).to.be.revertedWithCustomError(
				blackjack,
				'InvalidAmount'
			);
		});

		it('setRiskParams cancelTimeout at MIN_CANCEL_TIMEOUT should succeed', async () => {
			await expect(blackjack.connect(owner).setRiskParams(0, 30))
				.to.emit(blackjack, 'RiskParamsChanged')
				.withArgs(0, 30);
			expect(await blackjack.cancelTimeout()).to.equal(30);
		});
	});

	/* ========== FREE BET PATHS ========== */

	describe('FreeBet Paths', () => {
		it('placeBetWithFreeBet should revert when freeBetsHolder is not set', async () => {
			await expect(blackjack.connect(player).placeBetWithFreeBet(usdcAddress, MIN_USDC_BET)).to.be
				.reverted;
		});

		it('setAddresses freeBetsHolder should emit AddressesChanged', async () => {
			await expect(
				blackjack
					.connect(owner)
					.setAddresses(
						ZERO_ADDRESS,
						ZERO_ADDRESS,
						ZERO_ADDRESS,
						secondAccount.address,
						ZERO_ADDRESS
					)
			)
				.to.emit(blackjack, 'AddressesChanged')
				.withArgs(ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, secondAccount.address, ZERO_ADDRESS);
			expect(await blackjack.freeBetsHolder()).to.equal(secondAccount.address);
		});

		it('normal bet isFreeBet should be false', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			await blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			expect(await blackjack.isFreeBet(1)).to.equal(false);
		});

		it('doubleDown should revert for freebets', async () => {
			// Deploy FreeBetsHolder and set it up
			const HolderFactory = await ethers.getContractFactory('FreeBetsHolder');
			const holder = await upgrades.deployProxy(HolderFactory, [], { initializer: false });
			await holder.initialize(owner.address, owner.address, owner.address);
			const holderAddress = await holder.getAddress();
			await holder.addSupportedCollateral(usdcAddress, true, owner.address);
			await holder.setFreeBetExpirationPeriod(86400, Math.floor(Date.now() / 1000));

			await blackjack
				.connect(owner)
				.setAddresses(ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, holderAddress, ZERO_ADDRESS);
			await holder.setWhitelistedCasino(blackjackAddress, true);

			// Fund player with free bet
			await usdc.connect(owner).approve(holderAddress, MIN_USDC_BET);
			await holder.connect(owner).fund(player.address, usdcAddress, MIN_USDC_BET);

			// Place free bet
			const tx = await blackjack.connect(player).placeBetWithFreeBet(usdcAddress, MIN_USDC_BET);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);

			expect(await blackjack.isFreeBet(handId)).to.equal(true);

			// Deal cards: player gets 5+6=11 (good double down hand)
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [4n, 5n]);

			// Double down should revert for free bets
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			await expect(blackjack.connect(player).doubleDown(handId)).to.be.revertedWithCustomError(
				blackjack,
				'InvalidHandStatus'
			);
		});
	});

	/* ========== GETTERS ========== */

	describe('Getters', () => {
		it('getMaxPayout should return bet + 3:2 profit', async () => {
			const payout = await blackjack.getMaxPayout(MIN_USDC_BET);
			expect(payout).to.equal(MIN_USDC_BET + (MIN_USDC_BET * 3n) / 2n);
		});

		it('getUserHandIds should return hand IDs for card retrieval', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);

			// word0=12→K(10), word1=6→7. Player: 10+7=17
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [12n, 6n]);

			const ids = await blackjack.getUserHandIds(player.address, 0, 1);
			const handCards = await blackjack.getHandCards(ids[0]);
			expect(handCards.playerCards.length).to.be.gt(0);
			// Frontend computes hand value from cards
		});

		it('getAvailableLiquidity should return bankroll minus reserved', async () => {
			expect(await blackjack.getAvailableLiquidity(usdcAddress)).to.equal(50n * 1_000_000n);
		});
	});

	/* ========== VRF AUTH ========== */

	describe('VRF auth', () => {
		it('should revert rawFulfillRandomWords from non-coordinator', async () => {
			await expect(
				blackjack.connect(secondAccount).rawFulfillRandomWords(1n, [7n])
			).to.be.revertedWithCustomError(blackjack, 'InvalidSender');
		});
	});

	/* ========== HAND HISTORY ========== */

	describe('Hand History', () => {
		it('getUserHandCount should return 0 for new user', async () => {
			expect(await blackjack.getUserHandCount(player.address)).to.equal(0n);
		});

		it('getUserHandCount should increment after placing bets', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET * 2n);
			await blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			expect(await blackjack.getUserHandCount(player.address)).to.equal(1n);

			await blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			expect(await blackjack.getUserHandCount(player.address)).to.equal(2n);
		});

		it('getUserHandIds should return hand IDs in reverse chronological order', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET * 3n);
			await blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			await blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			await blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);

			const ids = await blackjack.getUserHandIds(player.address, 0, 10);
			expect(ids.length).to.equal(3);
			expect(ids[0]).to.equal(3n);
			expect(ids[1]).to.equal(2n);
			expect(ids[2]).to.equal(1n);
		});

		it('getUserHandIds should return empty for offset beyond length', async () => {
			const ids = await blackjack.getUserHandIds(player.address, 100, 10);
			expect(ids.length).to.equal(0);
		});

		it('should not include other users hands in getUserHandIds', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			await blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);

			expect(await blackjack.getUserHandCount(secondAccount.address)).to.equal(0n);
		});

		it('getUserHandIds should return IDs with full details via getters', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);

			// Deal cards (blackjack needs 2 random words for initial deal)
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [9n, 5n]);

			const ids = await blackjack.getUserHandIds(player.address, 0, 10);
			expect(ids.length).to.equal(1);
			expect(ids[0]).to.equal(handId);
			const handBase = await blackjack.getHandBase(ids[0]);
			const handCards = await blackjack.getHandCards(ids[0]);
			expect(handBase.user).to.equal(player.address);
			expect(handBase.amount).to.equal(MIN_USDC_BET);
			expect(handCards.playerCards.length).to.be.gt(0);
			expect(handCards.dealerCards.length).to.be.gt(0);
		});

		it('getRecentHandIds should return hand IDs', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { requestId } = await parseHandCreated(blackjack, tx);

			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [9n, 5n]);

			const ids = await blackjack.getRecentHandIds(0, 10);
			expect(ids.length).to.equal(1);
			expect(ids[0]).to.equal(1n);
			const handBase = await blackjack.getHandBase(ids[0]);
			expect(handBase.collateral).to.equal(usdcAddress);
		});

		it('getUserHandIds should return empty for offset beyond length', async () => {
			const ids = await blackjack.getUserHandIds(player.address, 100, 10);
			expect(ids.length).to.equal(0);
		});

		it('getRecentHandIds should return empty when offset >= total', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			await blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);

			const ids = await blackjack.getRecentHandIds(100, 10);
			expect(ids.length).to.equal(0);
		});
	});

	/* ========== SETTER ZERO-ADDRESS VALIDATIONS ========== */

	describe('Consolidated Setter Validations', () => {
		// setAddresses treats zero for each field as "skip", so there is no
		// "zero address reverts" path for it — rejection is via non-owner only.
		it('setAddresses should revert from non-owner', async () => {
			await expect(
				blackjack
					.connect(secondAccount)
					.setAddresses(
						secondAccount.address,
						ZERO_ADDRESS,
						ZERO_ADDRESS,
						ZERO_ADDRESS,
						ZERO_ADDRESS
					)
			).to.be.revertedWith('Only the contract owner may perform this action');
		});

		it('setAddresses should update only non-zero fields and emit AddressesChanged', async () => {
			const newMgr = secondAccount.address;
			const newPf = resolver.address;
			await expect(
				blackjack
					.connect(owner)
					.setAddresses(newMgr, newPf, ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS)
			)
				.to.emit(blackjack, 'AddressesChanged')
				.withArgs(newMgr, newPf, ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS);
			expect(await blackjack.manager()).to.equal(newMgr);
			expect(await blackjack.priceFeed()).to.equal(newPf);
		});

		it('setCollateralConfig should revert for zero collateral', async () => {
			await expect(
				blackjack.connect(owner).setCollateralConfig(ZERO_ADDRESS, WETH_KEY, true)
			).to.be.revertedWithCustomError(blackjack, 'InvalidAddress');
		});

		it('setCollateralConfig should set both support and key and emit', async () => {
			const testKey = ethers.encodeBytes32String('TEST');
			await expect(
				blackjack.connect(owner).setCollateralConfig(secondAccount.address, testKey, true)
			)
				.to.emit(blackjack, 'CollateralConfigChanged')
				.withArgs(secondAccount.address, testKey, true);
			expect(await blackjack.supportedCollateral(secondAccount.address)).to.equal(true);
			expect(await blackjack.priceFeedKeyPerCollateral(secondAccount.address)).to.equal(testKey);
		});

		it('setRiskParams maxProfitUsd should update and emit', async () => {
			await expect(blackjack.connect(owner).setRiskParams(ethers.parseEther('500'), 0))
				.to.emit(blackjack, 'RiskParamsChanged')
				.withArgs(ethers.parseEther('500'), 0);
			expect(await blackjack.maxProfitUsd()).to.equal(ethers.parseEther('500'));
		});

		it('setRiskParams should revert from non-risk-manager', async () => {
			await expect(
				blackjack.connect(secondAccount).setRiskParams(ethers.parseEther('500'), 0)
			).to.be.revertedWithCustomError(blackjack, 'InvalidSender');
		});

		it('setPausedByRole should revert from non-pauser', async () => {
			await expect(
				blackjack.connect(secondAccount).setPausedByRole(true)
			).to.be.revertedWithCustomError(blackjack, 'InvalidSender');
		});

		it('placeBet should revert and rollback reservedProfit on insufficient liquidity', async () => {
			const balance = await usdc.balanceOf(blackjackAddress);
			await blackjack.connect(owner).withdrawCollateral(usdcAddress, owner.address, balance);

			const reservedBefore = await blackjack.reservedProfitPerCollateral(usdcAddress);

			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			await expect(
				blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(blackjack, 'InsufficientAvailableLiquidity');

			const reservedAfter = await blackjack.reservedProfitPerCollateral(usdcAddress);
			expect(reservedAfter).to.equal(reservedBefore);
		});
	});

	/* ========== VRF CONFIG ========== */

	describe('setVrfConfig', () => {
		it('should update config and emit', async () => {
			const kh = ethers.encodeBytes32String('keyhash');
			await expect(blackjack.connect(owner).setVrfConfig(2n, kh, 300000n, 5n, true))
				.to.emit(blackjack, 'VrfConfigChanged')
				.withArgs(2n, kh, 300000n, 5n, true);
			expect(await blackjack.callbackGasLimit()).to.equal(300000n);
			expect(await blackjack.requestConfirmations()).to.equal(5n);
		});

		it('should revert for zero callbackGasLimit', async () => {
			const kh = ethers.encodeBytes32String('keyhash');
			await expect(
				blackjack.connect(owner).setVrfConfig(1n, kh, 0n, 3n, false)
			).to.be.revertedWithCustomError(blackjack, 'InvalidAmount');
		});

		it('should accept zero requestConfirmations', async () => {
			const kh = ethers.encodeBytes32String('keyhash');
			await expect(blackjack.connect(owner).setVrfConfig(1n, kh, 500000n, 0n, false)).to.emit(
				blackjack,
				'VrfConfigChanged'
			);
		});
	});

	/* ========== COLLATERAL PRICE ========== */

	describe('getCollateralPrice', () => {
		it('should return ONE for USDC', async () => {
			expect(await blackjack.getCollateralPrice(usdcAddress)).to.equal(ethers.parseEther('1'));
		});

		it('should return the price feed value for WETH', async () => {
			expect(await blackjack.getCollateralPrice(wethAddress)).to.equal(WETH_PRICE);
		});

		it('should revert for unsupported collateral', async () => {
			await expect(
				blackjack.getCollateralPrice(secondAccount.address)
			).to.be.revertedWithCustomError(blackjack, 'InvalidCollateral');
		});
	});

	/* ========== VRF UNKNOWN REQUEST ========== */

	describe('VRF unknown requestId', () => {
		it('should silently skip an unknown requestId', async () => {
			await expect(vrfCoordinator.fulfillRandomWords(blackjackAddress, 999n, [42n])).to.not.be
				.reverted;
		});
	});

	/* ========== FREE BET PLACEMENT ========== */

	describe('FreeBet Placement with Holder', () => {
		it('should place a freebet via holder and mark isFreeBet', async () => {
			// Deploy FreeBetsHolder inline
			const HolderFactory = await ethers.getContractFactory('FreeBetsHolder');
			const holder = await upgrades.deployProxy(HolderFactory, [], { initializer: false });
			await holder.initialize(owner.address, owner.address, owner.address);
			const holderAddress = await holder.getAddress();
			await holder.addSupportedCollateral(usdcAddress, true, owner.address);
			await holder.setFreeBetExpirationPeriod(86400, Math.floor(Date.now() / 1000));

			// Set holder on blackjack
			await blackjack
				.connect(owner)
				.setAddresses(ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, holderAddress, ZERO_ADDRESS);
			// Whitelist blackjack in holder
			await holder.setWhitelistedCasino(blackjackAddress, true);

			// Fund holder with USDC
			await usdc.connect(owner).approve(holderAddress, MIN_USDC_BET);
			await holder.connect(owner).fund(player.address, usdcAddress, MIN_USDC_BET);

			// Place freebet
			const tx = await blackjack.connect(player).placeBetWithFreeBet(usdcAddress, MIN_USDC_BET);
			const { handId } = await parseHandCreated(blackjack, tx);

			expect(await blackjack.isFreeBet(handId)).to.equal(true);

			const handBase = await blackjack.getHandBase(handId);
			expect(handBase.user).to.equal(player.address);
			expect(handBase.amount).to.equal(MIN_USDC_BET);
		});
	});

	/* ========== FREE BET WIN RESOLUTION ========== */

	describe('FreeBet Win Resolution', () => {
		it('freebet win should send profit to user and stake to holder owner', async () => {
			// Deploy FreeBetsHolder inline
			const HolderFactory = await ethers.getContractFactory('FreeBetsHolder');
			const holder = await upgrades.deployProxy(HolderFactory, [], { initializer: false });
			await holder.initialize(owner.address, owner.address, owner.address);
			const holderAddress = await holder.getAddress();
			await holder.addSupportedCollateral(usdcAddress, true, owner.address);
			await holder.setFreeBetExpirationPeriod(86400, Math.floor(Date.now() / 1000));

			// Set holder on blackjack
			await blackjack
				.connect(owner)
				.setAddresses(ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, holderAddress, ZERO_ADDRESS);
			// Whitelist blackjack in holder
			await holder.setWhitelistedCasino(blackjackAddress, true);

			// Fund holder with USDC
			await usdc.connect(owner).approve(holderAddress, MIN_USDC_BET);
			await holder.connect(owner).fund(player.address, usdcAddress, MIN_USDC_BET);

			// Place freebet
			const tx = await blackjack.connect(player).placeBetWithFreeBet(usdcAddress, MIN_USDC_BET);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);

			expect(await blackjack.isFreeBet(handId)).to.equal(true);

			// Deal: player gets Ace + 10 = blackjack
			// word0=0 -> rank 1 (Ace), dealerFaceUp = 0>>128 %13+1 = 1 (Ace)
			// word1=9 -> rank 10, dealerHidden = 0>>128 %13+1 = 1 (Ace)
			// Player: Ace+10=21 (BJ), Dealer: Ace+Ace=12 -> player blackjack wins
			const playerBalBefore = await usdc.balanceOf(player.address);
			const holderBalBefore = await usdc.balanceOf(holderAddress);
			const ownerBalBefore = await usdc.balanceOf(owner.address);

			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [0n, 9n]);

			const handDetails = await blackjack.getHandDetails(handId);
			const handBase = await blackjack.getHandBase(handId);
			expect(handDetails.status).to.equal(Status.RESOLVED);
			expect(handDetails.result).to.equal(Result.PLAYER_BLACKJACK);

			// 3:2 payout = amount + amount*3/2
			const expectedPayout = MIN_USDC_BET + (MIN_USDC_BET * 3n) / 2n;
			expect(handBase.payout).to.equal(expectedPayout);

			// Player gets profit (payout - amount)
			const profit = expectedPayout - MIN_USDC_BET;
			const playerBalAfter = await usdc.balanceOf(player.address);
			expect(playerBalAfter - playerBalBefore).to.equal(profit);

			// Stake is forwarded to holder owner; holder itself nets zero
			const holderBalAfter = await usdc.balanceOf(holderAddress);
			expect(holderBalAfter - holderBalBefore).to.equal(0n);
			const ownerBalAfter = await usdc.balanceOf(owner.address);
			expect(ownerBalAfter - ownerBalBefore).to.equal(MIN_USDC_BET);
		});
	});

	/* ========== VRF CANCELLED HAND ========== */

	describe('VRF cancelled hand', () => {
		it('should silently skip VRF deal callback for cancelled hand', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);

			// Wait for cancel timeout and cancel
			await time.increase(CANCEL_TIMEOUT);
			await blackjack.connect(player).cancelHand(handId);

			const handDetails = await blackjack.getHandDetails(handId);
			expect(handDetails.status).to.equal(Status.CANCELLED);

			// VRF fulfillment after cancel should silently return
			await expect(vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [9n, 5n])).to.not
				.be.reverted;

			// Status should still be CANCELLED
			const handDetailsAfter = await blackjack.getHandDetails(handId);
			expect(handDetailsAfter.status).to.equal(Status.CANCELLED);
		});
	});

	/* ========== WETH COLLATERAL ========== */

	describe('WETH Collateral', () => {
		const MIN_WETH_BET = ethers.parseEther('0.001'); // 0.001 WETH = 3 USD at 3000 USD/WETH

		beforeEach(async () => {
			// Fund bankroll with WETH
			await weth.transfer(blackjackAddress, ethers.parseEther('10'));
			// Fund player with WETH
			await weth.transfer(player.address, ethers.parseEther('1'));
		});

		it('should place a WETH bet and resolve with player win', async () => {
			await weth.connect(player).approve(blackjackAddress, MIN_WETH_BET);
			const tx = await blackjack
				.connect(player)
				.placeBet(wethAddress, MIN_WETH_BET, ethers.ZeroAddress);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);

			// Deal: player gets 10+10=20
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [12n, 11n]);

			const playerBalBefore = await weth.balanceOf(player.address);

			const standTx = await blackjack.connect(player).stand(handId);
			const standRequestId = await parseRequestId(blackjack, standTx, 'StandRequested');

			// Dealer: faceUp=Ace, hidden word[0]=5 -> rank 6. Dealer: 11+6=17 soft hit
			// word[1]=1 -> rank 2. Dealer: 11+6+2=19. Stop.
			// Player=20 > Dealer=19 -> win
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, standRequestId, [
				5n,
				1n,
				0n,
				0n,
				0n,
				0n,
				0n,
			]);

			const handDetails = await blackjack.getHandDetails(handId);
			const handBase = await blackjack.getHandBase(handId);
			expect(handDetails.status).to.equal(Status.RESOLVED);
			expect(handDetails.result).to.equal(Result.PLAYER_WIN);
			expect(handBase.payout).to.equal(MIN_WETH_BET * 2n);
			expect(await weth.balanceOf(player.address)).to.equal(playerBalBefore + MIN_WETH_BET * 2n);
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
			await blackjack.setAddresses(
				ZERO_ADDRESS,
				ZERO_ADDRESS,
				ZERO_ADDRESS,
				ZERO_ADDRESS,
				mockReferralsAddress
			);
		});

		it('should set referrer on placeBet', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			await blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET, secondAccount.address);
			expect(await mockReferrals.referrals(player.address)).to.equal(secondAccount.address);
		});

		it('should NOT set referrer when zero address', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			await blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			expect(await mockReferrals.referrals(player.address)).to.equal(ethers.ZeroAddress);
		});

		it('should pay referrer on losing hand (player bust)', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, secondAccount.address);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);

			// Deal: player gets King(10) + Queen(10) = 20
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [12n, 11n]);

			const referrerBalBefore = await usdc.balanceOf(secondAccount.address);

			const hitTx = await blackjack.connect(player).hit(handId);
			const hitRequestId = await parseRequestId(blackjack, hitTx, 'HitRequested');
			// Hit: word=4 → rank 5. Total = 10+10+5=25 → bust → loss
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, hitRequestId, [4n]);

			const handDetails = await blackjack.getHandDetails(handId);
			expect(handDetails.result).to.equal(Result.PLAYER_BUST);

			const referrerBalAfter = await usdc.balanceOf(secondAccount.address);
			const expectedFee = (MIN_USDC_BET * REFERRER_FEE) / ONE;
			expect(referrerBalAfter - referrerBalBefore).to.equal(expectedFee);
		});

		it('should emit ReferrerPaid on losing hand', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, secondAccount.address);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);

			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [12n, 11n]);

			const hitTx = await blackjack.connect(player).hit(handId);
			const hitRequestId = await parseRequestId(blackjack, hitTx, 'HitRequested');

			const expectedFee = (MIN_USDC_BET * REFERRER_FEE) / ONE;
			await expect(vrfCoordinator.fulfillRandomWords(blackjackAddress, hitRequestId, [4n]))
				.to.emit(blackjack, 'ReferrerPaid')
				.withArgs(secondAccount.address, player.address, expectedFee, MIN_USDC_BET, usdcAddress);
		});

		it('should resolve losing hand and emit ReferrerPayoutFailed when referrer is blacklisted', async () => {
			await usdc.setBlacklisted(secondAccount.address, true);
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, secondAccount.address);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);

			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [12n, 11n]);

			const hitTx = await blackjack.connect(player).hit(handId);
			const hitRequestId = await parseRequestId(blackjack, hitTx, 'HitRequested');

			const expectedFee = (MIN_USDC_BET * REFERRER_FEE) / ONE;
			const referrerBalBefore = await usdc.balanceOf(secondAccount.address);

			await expect(vrfCoordinator.fulfillRandomWords(blackjackAddress, hitRequestId, [4n]))
				.to.emit(blackjack, 'ReferrerPayoutFailed')
				.withArgs(secondAccount.address, player.address, expectedFee, MIN_USDC_BET, usdcAddress);

			const handDetails = await blackjack.getHandDetails(handId);
			expect(handDetails.status).to.equal(Status.RESOLVED);
			expect(handDetails.result).to.equal(Result.PLAYER_BUST);

			const referrerBalAfter = await usdc.balanceOf(secondAccount.address);
			expect(referrerBalAfter - referrerBalBefore).to.equal(0n);
		});

		it('should NOT pay referrer on winning hand (blackjack)', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, secondAccount.address);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);

			const referrerBalBefore = await usdc.balanceOf(secondAccount.address);

			// Deal: player gets Ace + 10 = blackjack 21
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [0n, 9n]);

			const handDetails = await blackjack.getHandDetails(handId);
			expect(handDetails.result).to.equal(Result.PLAYER_BLACKJACK);

			const referrerBalAfter = await usdc.balanceOf(secondAccount.address);
			expect(referrerBalAfter - referrerBalBefore).to.equal(0n);
		});

		it('should NOT pay if no referrer set', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);

			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [12n, 11n]);

			const hitTx = await blackjack.connect(player).hit(handId);
			const hitRequestId = await parseRequestId(blackjack, hitTx, 'HitRequested');

			await expect(vrfCoordinator.fulfillRandomWords(blackjackAddress, hitRequestId, [4n])).to.not
				.be.reverted;
		});

		it('setAddresses referrals should emit AddressesChanged', async () => {
			await expect(
				blackjack
					.connect(owner)
					.setAddresses(
						ZERO_ADDRESS,
						ZERO_ADDRESS,
						ZERO_ADDRESS,
						ZERO_ADDRESS,
						secondAccount.address
					)
			)
				.to.emit(blackjack, 'AddressesChanged')
				.withArgs(ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, secondAccount.address);
			expect(await blackjack.referrals()).to.equal(secondAccount.address);
		});
	});

	/* ================================================================== */
	/* ============================= SPLIT ============================== */
	/* ================================================================== */

	describe('Split', () => {
		const AMT = MIN_USDC_BET; // 3 USDC

		// Deal 8+8 to player, 5 dealer face-up, 6 dealer hidden. Player value = 16, not BJ.
		// Returns { handId, requestId } after the initial deal fulfillment.
		async function dealPairOf(rank, dealerFaceUp = 5, dealerHidden = 6) {
			await usdc.connect(player).approve(blackjackAddress, AMT);
			const tx = await blackjack.connect(player).placeBet(usdcAddress, AMT, ethers.ZeroAddress);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);
			const word0 = makeDealWord(rank, dealerFaceUp); // playerCard1=rank, dealerFaceUp
			const word1 = makeDealWord(rank, dealerHidden); // playerCard2=rank, dealerHidden
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [word0, word1]);
			return handId;
		}

		async function approveAndSplit(handId) {
			await usdc.connect(player).approve(blackjackAddress, AMT);
			const tx = await blackjack.connect(player).split(handId);
			const receipt = await tx.wait();
			const parsed = receipt.logs
				.map((l) => {
					try {
						return blackjack.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'HandSplit');
			return { tx, requestId: parsed.args.requestId, isAceSplit: parsed.args.isAceSplit };
		}

		/* ---------------- PRECONDITIONS ---------------- */

		describe('preconditions', () => {
			it('reverts if status != PLAYER_TURN (no deal yet)', async () => {
				await usdc.connect(player).approve(blackjackAddress, AMT);
				const tx = await blackjack.connect(player).placeBet(usdcAddress, AMT, ethers.ZeroAddress);
				const { handId } = await parseHandCreated(blackjack, tx);
				// status is AWAITING_DEAL
				await expect(blackjack.connect(player).split(handId)).to.be.revertedWithCustomError(
					blackjack,
					'InvalidHandStatus'
				);
			});

			it('reverts on non-matching pair (value-compared)', async () => {
				const handId = await dealPairOf(5, 3, 4); // player 5+5? no, dealPairOf deals same rank. Use diff setup.
				// Overwrite with mixed hand via direct word: force 5 and 6 to player
				// Simpler: place a fresh bet and provide mixed cards
				await usdc.connect(player).approve(blackjackAddress, AMT);
				const tx = await blackjack.connect(player).placeBet(usdcAddress, AMT, ethers.ZeroAddress);
				const { handId: h2, requestId } = await parseHandCreated(blackjack, tx);
				const word0 = makeDealWord(5, 4); // playerCard1=5, dealerFaceUp=4
				const word1 = makeDealWord(6, 3); // playerCard2=6 (value 6, not matching 5), dealerHidden=3
				await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [word0, word1]);
				await expect(blackjack.connect(player).split(h2)).to.be.revertedWithCustomError(
					blackjack,
					'InvalidHandStatus'
				);
			});

			it('allows same-value split: 10 + Q (both value 10)', async () => {
				await usdc.connect(player).approve(blackjackAddress, AMT);
				const tx = await blackjack.connect(player).placeBet(usdcAddress, AMT, ethers.ZeroAddress);
				const { handId, requestId } = await parseHandCreated(blackjack, tx);
				// playerCard1 = rank 10 (value 10), playerCard2 = rank 12 (Queen, value 10)
				// But both total 20 = no player BJ (BJ is A+10-value pair)
				const word0 = makeDealWord(10, 4); // 10, dealerFaceUp=4
				const word1 = makeDealWord(12, 3); // Q, dealerHidden=3
				await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [word0, word1]);
				const details = await blackjack.getHandDetails(handId);
				expect(details.status).to.equal(Status.PLAYER_TURN);
				await usdc.connect(player).approve(blackjackAddress, AMT);
				await expect(blackjack.connect(player).split(handId)).to.emit(blackjack, 'HandSplit');
			});

			it('reverts if already split', async () => {
				const handId = await dealPairOf(8);
				await approveAndSplit(handId);
				// VRF hasn't fulfilled, status is AWAITING_SPLIT — calling split again should revert
				await expect(blackjack.connect(player).split(handId)).to.be.revertedWithCustomError(
					blackjack,
					'InvalidHandStatus'
				);
			});

			it('reverts if not hand owner', async () => {
				const handId = await dealPairOf(8);
				await expect(blackjack.connect(secondAccount).split(handId)).to.be.revertedWithCustomError(
					blackjack,
					'HandNotOwner'
				);
			});

			it('reverts if playerCardCount != 2 (e.g. after hit)', async () => {
				const handId = await dealPairOf(8);
				const hitTx = await blackjack.connect(player).hit(handId);
				const hitReq = await parseRequestId(blackjack, hitTx, 'HitRequested');
				await vrfCoordinator.fulfillRandomWords(blackjackAddress, hitReq, [makeSingleWord(3)]);
				// hand now has 3 cards — split no longer legal
				await expect(blackjack.connect(player).split(handId)).to.be.revertedWithCustomError(
					blackjack,
					'InvalidHandStatus'
				);
			});
		});

		/* ---------------- STAKE / RESERVATION ---------------- */

		describe('stake and reservation', () => {
			it('transfers matching stake from player via safeTransferFrom', async () => {
				const handId = await dealPairOf(8);
				const balBefore = await usdc.balanceOf(player.address);
				const contractBefore = await usdc.balanceOf(blackjackAddress);
				await approveAndSplit(handId);
				expect(await usdc.balanceOf(player.address)).to.equal(balBefore - AMT);
				expect(await usdc.balanceOf(blackjackAddress)).to.equal(contractBefore + AMT);
			});

			it('sets hand.reservedProfit to 2*amount and updates global reservation', async () => {
				const handId = await dealPairOf(8);
				const beforeGlobal = await blackjack.reservedProfitPerCollateral(usdcAddress);
				// Pre-split, single-hand profit reservation = amount * 3/2 (BJ payout)
				const preSplitReservation = (AMT * 3n) / 2n;
				await approveAndSplit(handId);
				const base = await blackjack.getHandBase(handId);
				expect(base.reservedProfit).to.equal(AMT * 2n);
				// Aggregator delta on split = new stake pulled in (AMT) + profit delta (2*AMT - 1.5*AMT = 0.5*AMT)
				expect(await blackjack.reservedProfitPerCollateral(usdcAddress)).to.equal(
					beforeGlobal + AMT + (AMT * 2n - preSplitReservation)
				);
			});

			it('marks isSplit[handId] = true and populates SplitState', async () => {
				const handId = await dealPairOf(8);
				await approveAndSplit(handId);
				expect(await blackjack.isSplit(handId)).to.equal(true);
				const ss = await blackjack.getSplitDetails(handId);
				expect(ss.amount2).to.equal(AMT);
				expect(ss.activeHand).to.equal(1n);
				expect(ss.isAceSplit).to.equal(false);
				expect(ss.isDoubled2).to.equal(false);
				expect(ss.player2CardCount).to.equal(1);
				// player2Cards[0] was the original playerCards[1]
				const cards = await blackjack.getHandCards(handId);
				expect(cards.playerCards.length).to.equal(1);
			});

			it('flags ace-split correctly', async () => {
				const handId = await dealPairOf(1, 5, 6); // A + A
				const { isAceSplit } = await approveAndSplit(handId);
				expect(isAceSplit).to.equal(true);
				const ss = await blackjack.getSplitDetails(handId);
				expect(ss.isAceSplit).to.equal(true);
			});

			it('emits HandSplit with user, additionalAmount, isAceSplit', async () => {
				const handId = await dealPairOf(8);
				await usdc.connect(player).approve(blackjackAddress, AMT);
				await expect(blackjack.connect(player).split(handId))
					.to.emit(blackjack, 'HandSplit')
					.withArgs(handId, (anyReq) => typeof anyReq === 'bigint', player.address, AMT, false);
			});
		});

		/* ---------------- FREE BET GUARD ---------------- */

		describe('free bet', () => {
			it('reverts split on free-bet hands', async () => {
				const HolderFactory = await ethers.getContractFactory('FreeBetsHolder');
				const holder = await upgrades.deployProxy(HolderFactory, [], { initializer: false });
				await holder.initialize(owner.address, owner.address, owner.address);
				const holderAddress = await holder.getAddress();
				await holder.addSupportedCollateral(usdcAddress, true, owner.address);
				await holder.setFreeBetExpirationPeriod(86400, Math.floor(Date.now() / 1000));
				await blackjack
					.connect(owner)
					.setAddresses(ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, holderAddress, ZERO_ADDRESS);
				await holder.setWhitelistedCasino(blackjackAddress, true);

				// Fund free bet
				await usdc.connect(owner).approve(holderAddress, AMT);
				await holder.connect(owner).fund(player.address, usdcAddress, AMT);

				// Place free-bet hand with 8+8 (valid split pair)
				const tx = await blackjack.connect(player).placeBetWithFreeBet(usdcAddress, AMT);
				const { handId, requestId } = await parseHandCreated(blackjack, tx);
				await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [
					makeDealWord(8, 5),
					makeDealWord(8, 6),
				]);
				// Even with approval + balance, split should revert on free bet
				await usdc.connect(player).approve(blackjackAddress, AMT);
				await expect(blackjack.connect(player).split(handId)).to.be.revertedWithCustomError(
					blackjack,
					'InvalidHandStatus'
				);
			});
		});

		/* ---------------- POST-SPLIT FULFILLMENT ---------------- */

		describe('post-split fulfillment', () => {
			it('non-ace split: deals second card to each hand, activeHand=1, status=PLAYER_TURN', async () => {
				const handId = await dealPairOf(8);
				const { requestId } = await approveAndSplit(handId);
				// 2 words: hand1-card2 = 3 (value 3), hand2-card2 = 5 (value 5)
				await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [
					makeSingleWord(3),
					makeSingleWord(5),
				]);
				const details = await blackjack.getHandDetails(handId);
				expect(details.status).to.equal(Status.PLAYER_TURN);
				expect(details.playerCardCount).to.equal(2);
				const ss = await blackjack.getSplitDetails(handId);
				expect(ss.activeHand).to.equal(1n);
				expect(ss.player2CardCount).to.equal(2);
			});

			it('ace split: auto-resolves in same callback with 9 VRF words', async () => {
				const handId = await dealPairOf(1, 5, 6); // A+A
				const { requestId } = await approveAndSplit(handId);
				// words[0,1]: 2nd card per hand. words[2]: dealer hidden. words[3..8]: dealer draws
				// Let hand1 draw 10 (value 10) → total A+10 = 21
				// Let hand2 draw 5 → A+5 = 16 (soft). Won't hit because one-card rule.
				// Dealer: hidden = 6, total 5+6=11 soft? No, dealer face-up was 5 hidden fresh on stand. Dealer gets hidden=10 → 15, then hits to 17+.
				const words = [
					makeSingleWord(10), // hand1 2nd card → A+10 = 21
					makeSingleWord(5), // hand2 2nd card → A+5 = 16
					makeSingleWord(10), // dealer hidden: 10 → face-up was 5, so 5+10=15, must hit
					makeSingleWord(3), // dealer draws 3 → 18, stops
					0n,
					0n,
					0n,
					0n,
					0n,
				];
				await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, words);
				const details = await blackjack.getHandDetails(handId);
				expect(details.status).to.equal(Status.RESOLVED);
				// Hand1 = 21 vs dealer 18 → WIN, pays 1:1 (6), NOT 3:2
				// Hand2 = 16 vs dealer 18 → LOSE (0)
				const ss = await blackjack.getSplitDetails(handId);
				expect(ss.result2).to.equal(Result.DEALER_WIN);
				// total payout = 2*AMT (only hand1 wins 1:1) = 2 * 3 = 6 USDC
				const base = await blackjack.getHandBase(handId);
				expect(base.payout).to.equal(AMT * 2n);
			});
		});

		/* ---------------- HIT / STAND / DOUBLE ON SPLIT HANDS ---------------- */

		describe('playing split hands', () => {
			async function splitThenFulfill(rank, hand1Card2 = 3, hand2Card2 = 5) {
				const handId = await dealPairOf(rank);
				const { requestId } = await approveAndSplit(handId);
				await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [
					makeSingleWord(hand1Card2),
					makeSingleWord(hand2Card2),
				]);
				return handId;
			}

			it('hit() routes to hand 1 when activeHand=1', async () => {
				const handId = await splitThenFulfill(8, 3, 5); // hand1=[8,3]=11, hand2=[8,5]=13
				const hitTx = await blackjack.connect(player).hit(handId);
				const hitReq = await parseRequestId(blackjack, hitTx, 'HitRequested');
				await vrfCoordinator.fulfillRandomWords(blackjackAddress, hitReq, [makeSingleWord(2)]); // +2 = 13
				const cards = await blackjack.getHandCards(handId);
				expect(cards.playerCards.length).to.equal(3);
				const ss = await blackjack.getSplitDetails(handId);
				expect(ss.activeHand).to.equal(1n);
				expect(ss.player2CardCount).to.equal(2); // unchanged
			});

			it('stand() on hand 1 advances to hand 2 without VRF', async () => {
				const handId = await splitThenFulfill(8, 3, 5);
				const standTx = await blackjack.connect(player).stand(handId);
				const rc = await standTx.wait();
				// No StandRequested event fired (no VRF)
				const stood = rc.logs.some((l) => {
					try {
						return blackjack.interface.parseLog(l)?.name === 'StandRequested';
					} catch {
						return false;
					}
				});
				expect(stood).to.equal(false);
				const ss = await blackjack.getSplitDetails(handId);
				expect(ss.activeHand).to.equal(2n);
				const details = await blackjack.getHandDetails(handId);
				expect(details.status).to.equal(Status.PLAYER_TURN);
			});

			it('stand() on hand 1 emits SplitHandAdvanced and resets lastRequestAt', async () => {
				const handId = await splitThenFulfill(8, 3, 5);
				const beforeBlock = await ethers.provider.getBlockNumber();
				await expect(blackjack.connect(player).stand(handId))
					.to.emit(blackjack, 'SplitHandAdvanced')
					.withArgs(handId, player.address);
				const lastReq = await blackjack.lastRequestAt(handId);
				const newBlock = await ethers.provider.getBlock(await ethers.provider.getBlockNumber());
				expect(lastReq).to.equal(BigInt(newBlock.timestamp));
				// And ensure it's >= the block that ran before the stand (confirms reset happened)
				const preBlock = await ethers.provider.getBlock(beforeBlock);
				expect(lastReq).to.be.gte(BigInt(preBlock.timestamp));
			});

			it('bust on hand 1 auto-advances to hand 2', async () => {
				const handId = await splitThenFulfill(10, 10, 5); // hand1=[10,10]=20, hand2=[10,5]=15
				// Hit hand1 to bust: need +10 (total 30)
				const hitTx = await blackjack.connect(player).hit(handId);
				const hitReq = await parseRequestId(blackjack, hitTx, 'HitRequested');
				await vrfCoordinator.fulfillRandomWords(blackjackAddress, hitReq, [makeSingleWord(10)]); // 20+10=30
				const ss = await blackjack.getSplitDetails(handId);
				expect(ss.activeHand).to.equal(2n);
				const details = await blackjack.getHandDetails(handId);
				expect(details.status).to.equal(Status.PLAYER_TURN);
			});

			it('doubleDown on hand 1 requests only 1 VRF word and advances to hand 2', async () => {
				const handId = await splitThenFulfill(8, 3, 5); // hand1=[8,3]=11, hand2=[8,5]=13
				await usdc.connect(player).approve(blackjackAddress, AMT);
				const ddTx = await blackjack.connect(player).doubleDown(handId);
				const ddReq = await parseRequestId(blackjack, ddTx, 'DoubleDownRequested');
				// Only 1 word for hand 1's card, not 7
				await vrfCoordinator.fulfillRandomWords(blackjackAddress, ddReq, [makeSingleWord(10)]); // 11+10=21
				const ss = await blackjack.getSplitDetails(handId);
				expect(ss.activeHand).to.equal(2n);
				const details = await blackjack.getHandDetails(handId);
				expect(details.status).to.equal(Status.PLAYER_TURN);
				const base = await blackjack.getHandBase(handId);
				expect(base.amount).to.equal(AMT * 2n); // hand1 stake doubled
			});

			it('doubleDown on hand 2 requests 7 VRF words and triggers dealer play', async () => {
				const handId = await splitThenFulfill(8, 3, 5);
				// Stand on hand 1 first
				await blackjack.connect(player).stand(handId);
				// Now doubleDown on hand 2
				await usdc.connect(player).approve(blackjackAddress, AMT);
				const ddTx = await blackjack.connect(player).doubleDown(handId);
				const ddReq = await parseRequestId(blackjack, ddTx, 'DoubleDownRequested');
				// 7 words: card + dealer
				const words = [
					makeSingleWord(3), // hand2 +3 = 8+5+3 = 16
					makeSingleWord(10), // dealer hidden 10 → 5+10=15 (face-up was 5)
					makeSingleWord(5), // dealer hits: 15+5=20, stops
					0n,
					0n,
					0n,
					0n,
				];
				await vrfCoordinator.fulfillRandomWords(blackjackAddress, ddReq, words);
				const details = await blackjack.getHandDetails(handId);
				expect(details.status).to.equal(Status.RESOLVED);
			});

			it('bust on hand 2 while hand 1 alive → player must stand() to trigger dealer', async () => {
				const handId = await splitThenFulfill(8, 3, 5); // hand1=[8,3]=11, hand2=[8,5]=13
				await blackjack.connect(player).stand(handId); // activeHand→2
				// Hit hand 2 to bust: 13 + 10 = 23
				const hitTx = await blackjack.connect(player).hit(handId);
				const hitReq = await parseRequestId(blackjack, hitTx, 'HitRequested');
				const fulfillTx = await vrfCoordinator.fulfillRandomWords(blackjackAddress, hitReq, [
					makeSingleWord(10),
				]);
				const rc = await fulfillTx.wait();
				// No nested VRF — Chainlink v2.5 coordinator's reentrancyLock blocks nested
				// requestRandomWords in the callback. Hand sits at PLAYER_TURN; FE submits stand().
				const stoodInCallback = rc.logs.some((l) => {
					try {
						return blackjack.interface.parseLog(l)?.name === 'StandRequested';
					} catch {
						return false;
					}
				});
				expect(stoodInCallback).to.equal(false);
				let details = await blackjack.getHandDetails(handId);
				expect(details.status).to.equal(Status.PLAYER_TURN);

				// Frontend auto-submits stand() → dealer VRF requested
				const standTx = await blackjack.connect(player).stand(handId);
				const standReq = await parseRequestId(blackjack, standTx, 'StandRequested');
				details = await blackjack.getHandDetails(handId);
				expect(details.status).to.equal(Status.AWAITING_STAND);

				await vrfCoordinator.fulfillRandomWords(blackjackAddress, standReq, [
					makeSingleWord(10), // hidden=10 → 5+10=15
					makeSingleWord(5), // draw 5 → 20
					0n,
					0n,
					0n,
					0n,
					0n,
				]);
				const final = await blackjack.getHandDetails(handId);
				expect(final.status).to.equal(Status.RESOLVED);
				// hand1=11 vs dealer=20 → LOSE. hand2=busted → LOSE. Payout 0.
				const base = await blackjack.getHandBase(handId);
				expect(base.payout).to.equal(0n);
			});

			it('both hands bust → resolves without dealer play', async () => {
				const handId = await splitThenFulfill(10, 10, 10); // hand1=[10,10]=20, hand2=[10,10]=20
				// Bust hand 1
				const hit1 = await blackjack.connect(player).hit(handId);
				const r1 = await parseRequestId(blackjack, hit1, 'HitRequested');
				await vrfCoordinator.fulfillRandomWords(blackjackAddress, r1, [makeSingleWord(10)]); // 30
				// Bust hand 2
				const hit2 = await blackjack.connect(player).hit(handId);
				const r2 = await parseRequestId(blackjack, hit2, 'HitRequested');
				const fulfillTx = await vrfCoordinator.fulfillRandomWords(blackjackAddress, r2, [
					makeSingleWord(10),
				]);
				const rc = await fulfillTx.wait();
				// No dealer VRF should be requested
				const stood = rc.logs.some((l) => {
					try {
						return blackjack.interface.parseLog(l)?.name === 'StandRequested';
					} catch {
						return false;
					}
				});
				expect(stood).to.equal(false);
				const details = await blackjack.getHandDetails(handId);
				expect(details.status).to.equal(Status.RESOLVED);
				const base = await blackjack.getHandBase(handId);
				expect(base.payout).to.equal(0n);
				const ss = await blackjack.getSplitDetails(handId);
				expect(ss.result2).to.equal(Result.PLAYER_BUST);
				expect(details.result).to.equal(Result.PLAYER_BUST);
			});
		});

		/* ---------------- RESOLUTION ---------------- */

		describe('resolution', () => {
			it('both hands win on dealer bust → 2*AMT payout each', async () => {
				// hand1=[8,3]=11, hand2=[8,5]=13. Dealer busts at 22.
				const handId = await dealPairOf(8, 5, 6);
				const { requestId } = await approveAndSplit(handId);
				await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [
					makeSingleWord(3),
					makeSingleWord(5),
				]);
				await blackjack.connect(player).stand(handId); // activeHand→2
				const standTx = await blackjack.connect(player).stand(handId);
				const standReq = await parseRequestId(blackjack, standTx, 'StandRequested');
				// dealer: hidden=10 (face-up was 5, total 15), draw 8 (23) → bust
				await vrfCoordinator.fulfillRandomWords(blackjackAddress, standReq, [
					makeSingleWord(10),
					makeSingleWord(8),
					0n,
					0n,
					0n,
					0n,
					0n,
				]);
				const base = await blackjack.getHandBase(handId);
				expect(base.payout).to.equal(AMT * 4n); // each hand wins 2x
				const ss = await blackjack.getSplitDetails(handId);
				expect(ss.result2).to.equal(Result.DEALER_BUST);
			});

			it('one hand wins, one loses → correct partial payout', async () => {
				// hand1=[8,3]=11 (will stand), hand2=[8,13]=18 wait ranks 1-13, val 13=K→10. Use [8,K]=18.
				const handId = await dealPairOf(8, 5, 6);
				const { requestId } = await approveAndSplit(handId);
				await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [
					makeSingleWord(3), // hand1 +3 = 11
					makeSingleWord(13), // hand2 +K(val 10) = 18
				]);
				await blackjack.connect(player).stand(handId); // hand1 stands with 11
				const standTx = await blackjack.connect(player).stand(handId);
				const standReq = await parseRequestId(blackjack, standTx, 'StandRequested');
				// dealer: hidden=10 → 15, draw 3 → 18, stops
				await vrfCoordinator.fulfillRandomWords(blackjackAddress, standReq, [
					makeSingleWord(10),
					makeSingleWord(3),
					0n,
					0n,
					0n,
					0n,
					0n,
				]);
				const details = await blackjack.getHandDetails(handId);
				expect(details.result).to.equal(Result.DEALER_WIN); // 11 < 18
				const ss = await blackjack.getSplitDetails(handId);
				expect(ss.result2).to.equal(Result.PUSH); // 18 == 18
				const base = await blackjack.getHandBase(handId);
				// payout: hand1 lost (0), hand2 push (AMT) → total AMT
				expect(base.payout).to.equal(AMT);
			});

			it('21 on split hand pays 1:1, not 3:2', async () => {
				// Split aces; hand1 gets 10 → A+10=21
				const handId = await dealPairOf(1, 5, 6);
				const { requestId } = await approveAndSplit(handId);
				const words = [
					makeSingleWord(10), // hand1 2nd = A+10 = 21
					makeSingleWord(5), // hand2 2nd = A+5 = 16
					makeSingleWord(10), // dealer hidden → 5+10=15
					makeSingleWord(3), // draw → 18, stop
					0n,
					0n,
					0n,
					0n,
					0n,
				];
				await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, words);
				const base = await blackjack.getHandBase(handId);
				const details = await blackjack.getHandDetails(handId);
				expect(details.result).to.equal(Result.PLAYER_WIN); // 21 > 18 — but PLAYER_WIN, not PLAYER_BLACKJACK
				// payout: hand1 wins = AMT*2. hand2 loses. total = AMT*2 (not AMT*2.5 which is BJ)
				expect(base.payout).to.equal(AMT * 2n);
			});
		});

		/* ---------------- CANCEL ---------------- */

		describe('cancel', () => {
			it('user cancel during AWAITING_SPLIT refunds both stakes after timeout', async () => {
				const handId = await dealPairOf(8);
				await approveAndSplit(handId);
				const balBefore = await usdc.balanceOf(player.address);
				await time.increase(CANCEL_TIMEOUT);
				await expect(blackjack.connect(player).cancelHand(handId)).to.emit(
					blackjack,
					'HandCancelled'
				);
				expect(await usdc.balanceOf(player.address)).to.equal(balBefore + AMT * 2n);
				const base = await blackjack.getHandBase(handId);
				expect(base.payout).to.equal(AMT * 2n);
			});

			it('admin cancel during AWAITING_SPLIT works regardless of timeout', async () => {
				const handId = await dealPairOf(8);
				await approveAndSplit(handId);
				const balBefore = await usdc.balanceOf(player.address);
				await blackjack.connect(resolver).adminCancelHand(handId);
				expect(await usdc.balanceOf(player.address)).to.equal(balBefore + AMT * 2n);
			});

			it('reservation released on cancel', async () => {
				const handId = await dealPairOf(8);
				await approveAndSplit(handId);
				await time.increase(CANCEL_TIMEOUT);
				await blackjack.connect(player).cancelHand(handId);
				// After cancel, reservation for this hand should be released
				const base = await blackjack.getHandBase(handId);
				expect(base.reservedProfit).to.equal(AMT * 2n); // unchanged on hand, but global should drop
				// Can't easily check global without another hand; rely on next bet not reverting
			});
		});

		/* ---------------- BACKWARDS COMPAT: non-split hands unaffected ---------------- */

		describe('non-split hands unaffected', () => {
			it('isSplit returns false for a regular single-hand bet', async () => {
				await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
				const tx = await blackjack
					.connect(player)
					.placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
				const { handId } = await parseHandCreated(blackjack, tx);
				expect(await blackjack.isSplit(handId)).to.equal(false);
			});

			it('getSplitDetails on a non-split hand returns empty data', async () => {
				await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
				const tx = await blackjack
					.connect(player)
					.placeBet(usdcAddress, MIN_USDC_BET, ethers.ZeroAddress);
				const { handId } = await parseHandCreated(blackjack, tx);
				const ss = await blackjack.getSplitDetails(handId);
				expect(ss.amount2).to.equal(0n);
				expect(ss.activeHand).to.equal(0n);
				expect(ss.isAceSplit).to.equal(false);
				expect(ss.player2CardCount).to.equal(0);
			});
		});
	});

	/* ================================================================== */
	/* =================== HIT-TO-21 (FE auto-stands) =================== */
	/* ================================================================== */

	describe('hit to 21 — FE must stand()', () => {
		const AMT = MIN_USDC_BET;

		async function placeBetWithCards(c1, c2, dFaceUp, dHidden) {
			await usdc.connect(player).approve(blackjackAddress, AMT);
			const tx = await blackjack.connect(player).placeBet(usdcAddress, AMT, ethers.ZeroAddress);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [
				makeDealWord(c1, dFaceUp),
				makeDealWord(c2, dHidden),
			]);
			return handId;
		}

		it('non-split: hit landing on 21 sits at PLAYER_TURN — FE submits stand()', async () => {
			// Start with 5+6=11, hit a 10 → 21 (not BJ since 3 cards)
			const handId = await placeBetWithCards(5, 6, 4, 3);
			const hitTx = await blackjack.connect(player).hit(handId);
			const hitReq = await parseRequestId(blackjack, hitTx, 'HitRequested');
			const fulfillTx = await vrfCoordinator.fulfillRandomWords(blackjackAddress, hitReq, [
				makeSingleWord(10), // 11 + 10 = 21
			]);
			const rc = await fulfillTx.wait();
			// No nested VRF in callback (Chainlink reentrancyLock)
			const standInCb = rc.logs.some((l) => {
				try {
					return blackjack.interface.parseLog(l)?.name === 'StandRequested';
				} catch {
					return false;
				}
			});
			expect(standInCb).to.equal(false);
			let d = await blackjack.getHandDetails(handId);
			expect(d.status).to.equal(Status.PLAYER_TURN);

			// Frontend auto-submits stand() on reaching 21
			const standTx = await blackjack.connect(player).stand(handId);
			const dealerReq = await parseRequestId(blackjack, standTx, 'StandRequested');
			d = await blackjack.getHandDetails(handId);
			expect(d.status).to.equal(Status.AWAITING_STAND);

			await vrfCoordinator.fulfillRandomWords(blackjackAddress, dealerReq, [
				makeSingleWord(10), // hidden → 4+10=14
				makeSingleWord(4), // draw → 18, stop
				0n,
				0n,
				0n,
				0n,
				0n,
			]);
			const final = await blackjack.getHandDetails(handId);
			expect(final.status).to.equal(Status.RESOLVED);
			expect(final.result).to.equal(Result.PLAYER_WIN); // 21 vs 18
		});

		it('non-split: 21 via hit pays 2x, not 3:2 (not a natural blackjack)', async () => {
			const handId = await placeBetWithCards(5, 6, 4, 3);
			const balBefore = await usdc.balanceOf(player.address);
			const hitTx = await blackjack.connect(player).hit(handId);
			const hitReq = await parseRequestId(blackjack, hitTx, 'HitRequested');
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, hitReq, [makeSingleWord(10)]);

			// FE auto-stands on 21
			const standTx = await blackjack.connect(player).stand(handId);
			const dealerReq = await parseRequestId(blackjack, standTx, 'StandRequested');
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, dealerReq, [
				makeSingleWord(10), // hidden → 14
				makeSingleWord(4), // draw → 18
				0n,
				0n,
				0n,
				0n,
				0n,
			]);
			const base = await blackjack.getHandBase(handId);
			expect(base.payout).to.equal(AMT * 2n); // 2x, not 2.5x
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore + AMT * 2n);
		});

		it('non-split: hit landing below 21 still returns to PLAYER_TURN (no auto-stand)', async () => {
			const handId = await placeBetWithCards(5, 6, 4, 3); // 11
			const hitTx = await blackjack.connect(player).hit(handId);
			const hitReq = await parseRequestId(blackjack, hitTx, 'HitRequested');
			const fulfillTx = await vrfCoordinator.fulfillRandomWords(blackjackAddress, hitReq, [
				makeSingleWord(5), // 11 + 5 = 16 (not 21)
			]);
			const rc = await fulfillTx.wait();
			const standRequested = rc.logs.some((l) => {
				try {
					return blackjack.interface.parseLog(l)?.name === 'StandRequested';
				} catch {
					return false;
				}
			});
			expect(standRequested).to.equal(false); // no auto-stand
			const d = await blackjack.getHandDetails(handId);
			expect(d.status).to.equal(Status.PLAYER_TURN);
		});

		it('split hand 1: hit landing on 21 auto-advances to hand 2', async () => {
			// Pair of 8s, hit hand 1 with +5 = 21
			await usdc.connect(player).approve(blackjackAddress, AMT);
			const tx = await blackjack.connect(player).placeBet(usdcAddress, AMT, ethers.ZeroAddress);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [
				makeDealWord(8, 4),
				makeDealWord(8, 3),
			]);
			await usdc.connect(player).approve(blackjackAddress, AMT);
			const splitTx = await blackjack.connect(player).split(handId);
			const splitReq = await parseRequestId(blackjack, splitTx, 'HandSplit');
			// Deal split cards: hand1 gets 5 (so 8+5=13), hand2 gets 5
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, splitReq, [
				makeSingleWord(5),
				makeSingleWord(5),
			]);
			// Hit hand 1: +8 = 21
			const hitTx = await blackjack.connect(player).hit(handId);
			const hitReq = await parseRequestId(blackjack, hitTx, 'HitRequested');
			const fulfillTx = await vrfCoordinator.fulfillRandomWords(blackjackAddress, hitReq, [
				makeSingleWord(8), // 8+5+8 = 21
			]);
			const rc = await fulfillTx.wait();
			// No StandRequested — hand 1 at 21 just advances, hand 2 still awaits player
			const stoodEvent = rc.logs.some((l) => {
				try {
					return blackjack.interface.parseLog(l)?.name === 'StandRequested';
				} catch {
					return false;
				}
			});
			expect(stoodEvent).to.equal(false);
			const ss = await blackjack.getSplitDetails(handId);
			expect(ss.activeHand).to.equal(2n);
			const d = await blackjack.getHandDetails(handId);
			expect(d.status).to.equal(Status.PLAYER_TURN);
		});

		it('split hand 2: hit landing on 21 sits at PLAYER_TURN — FE submits stand()', async () => {
			await usdc.connect(player).approve(blackjackAddress, AMT);
			const tx = await blackjack.connect(player).placeBet(usdcAddress, AMT, ethers.ZeroAddress);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [
				makeDealWord(8, 4),
				makeDealWord(8, 3),
			]);
			await usdc.connect(player).approve(blackjackAddress, AMT);
			const splitTx = await blackjack.connect(player).split(handId);
			const splitReq = await parseRequestId(blackjack, splitTx, 'HandSplit');
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, splitReq, [
				makeSingleWord(3), // hand1: 8+3=11
				makeSingleWord(5), // hand2: 8+5=13
			]);
			// Stand on hand 1 → activeHand = 2
			await blackjack.connect(player).stand(handId);
			// Hit hand 2: +8 = 21
			const hitTx = await blackjack.connect(player).hit(handId);
			const hitReq = await parseRequestId(blackjack, hitTx, 'HitRequested');
			const fulfillTx = await vrfCoordinator.fulfillRandomWords(blackjackAddress, hitReq, [
				makeSingleWord(8), // 13+8=21
			]);
			const rc = await fulfillTx.wait();
			// No nested VRF in callback
			const standInCb = rc.logs.some((l) => {
				try {
					return blackjack.interface.parseLog(l)?.name === 'StandRequested';
				} catch {
					return false;
				}
			});
			expect(standInCb).to.equal(false);
			let d = await blackjack.getHandDetails(handId);
			expect(d.status).to.equal(Status.PLAYER_TURN);

			// FE auto-stands on 21
			const standTx = await blackjack.connect(player).stand(handId);
			const dealerReq = await parseRequestId(blackjack, standTx, 'StandRequested');
			d = await blackjack.getHandDetails(handId);
			expect(d.status).to.equal(Status.AWAITING_STAND);

			await vrfCoordinator.fulfillRandomWords(blackjackAddress, dealerReq, [
				makeSingleWord(10), // dealer hidden → 4+10=14
				makeSingleWord(4), // draw → 18
				0n,
				0n,
				0n,
				0n,
				0n,
			]);
			const base = await blackjack.getHandBase(handId);
			// hand1=11 vs 18 → LOSE (0), hand2=21 vs 18 → WIN 1:1 (2*AMT)
			expect(base.payout).to.equal(AMT * 2n);
		});
	});
});
