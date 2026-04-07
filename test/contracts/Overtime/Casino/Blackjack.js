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
};

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
	let blackjack, blackjackAddress, usdc, usdcAddress, vrfCoordinator;
	let owner, secondAccount, resolver, riskManager, pauser, player;

	beforeEach(async () => {
		({
			blackjack,
			blackjackAddress,
			usdc,
			usdcAddress,
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
	});

	/* ========== PLACE BET ========== */

	describe('placeBet', () => {
		it('should revert for unsupported collateral', async () => {
			await expect(
				blackjack.connect(player).placeBet(secondAccount.address, MIN_USDC_BET)
			).to.be.revertedWithCustomError(blackjack, 'InvalidCollateral');
		});

		it('should revert for zero amount', async () => {
			await expect(
				blackjack.connect(player).placeBet(usdcAddress, 0)
			).to.be.revertedWithCustomError(blackjack, 'InvalidAmount');
		});

		it('should revert when paused', async () => {
			await blackjack.connect(pauser).setPausedByRole(true);
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			await expect(blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET)).to.be.reverted;
		});

		it('should place a bet and emit HandCreated', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			await expect(blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET))
				.to.emit(blackjack, 'HandCreated')
				.withArgs(1n, 1n, player.address, usdcAddress, MIN_USDC_BET);

			const hand = await blackjack.hands(1n);
			expect(hand.user).to.equal(player.address);
			expect(hand.status).to.equal(Status.AWAITING_DEAL);
			expect(await blackjack.nextHandId()).to.equal(2n);
		});
	});

	/* ========== DEAL (VRF FULFILLMENT) ========== */

	describe('Deal', () => {
		it('should deal initial cards and set PLAYER_TURN', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);

			// Use words that produce non-blackjack hands
			// word0: playerCard1 = (100 % 13) + 1 = 10, dealerFaceUp = ((100 >> 128) % 13) + 1 = 1 (Ace)
			// word1: playerCard2 = (200 % 13) + 1 = 6, dealerHidden = ((200 >> 128) % 13) + 1 = 1
			// Actually let's use simple values to control outcome
			// word0 = 9 → playerCard1 = (9%13)+1 = 10, dealerFaceUp = ((9>>128)%13)+1 = 1 (0>>128=0, 0%13+1=1)
			// word1 = 5 → playerCard2 = (5%13)+1 = 6, dealerHidden = 1
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [9n, 5n]);

			const hand = await blackjack.hands(handId);
			expect(hand.status).to.equal(Status.PLAYER_TURN);
			expect(hand.playerCardCount).to.equal(2n);
			expect(hand.dealerCardCount).to.equal(1n);

			const views = await blackjack.getUserHands(player.address, 0, 1);
			expect(views[0].playerCards.length).to.equal(2);
			expect(views[0].dealerCards.length).to.equal(1);
		});

		it('should auto-resolve player blackjack (6:5 payout)', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);

			const playerBalanceBefore = await usdc.balanceOf(player.address);

			// Need playerCard1=Ace(1), playerCard2=10-value
			// word0: (word0 % 13)+1 = 1 → word0 % 13 = 0 → word0 = 0
			// word1: (word1 % 13)+1 = 10 → word1 % 13 = 9 → word1 = 9
			// dealerFaceUp: (0 >> 128) % 13 + 1 = 1 (Ace) — dealer also gets Ace
			// dealerHidden: (9 >> 128) % 13 + 1 = 1 (Ace) — dealer doesn't have blackjack (A+A=12)
			// So player has BJ (A+10=21), dealer has A+A=12 → player blackjack wins
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [0n, 9n]);

			const hand = await blackjack.hands(handId);
			expect(hand.status).to.equal(Status.RESOLVED);
			expect(hand.result).to.equal(Result.PLAYER_BLACKJACK);

			// 6:5 payout = amount + amount*6/5 = 3 + 3.6 = 6.6 USDC
			const expectedPayout = MIN_USDC_BET + (MIN_USDC_BET * 6n) / 5n;
			expect(hand.payout).to.equal(expectedPayout);
			expect(await usdc.balanceOf(player.address)).to.equal(playerBalanceBefore + expectedPayout);
		});

		it('should push when both player and dealer have blackjack', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET);
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

			const hand = await blackjack.hands(handId);
			expect(hand.status).to.equal(Status.RESOLVED);
			expect(hand.result).to.equal(Result.PUSH);
			expect(hand.payout).to.equal(MIN_USDC_BET); // bet returned
			expect(await usdc.balanceOf(player.address)).to.equal(playerBalanceBefore + MIN_USDC_BET);
		});
	});

	/* ========== HIT ========== */

	describe('Hit', () => {
		it('should revert if not hand owner', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [9n, 5n]);

			await expect(blackjack.connect(secondAccount).hit(handId)).to.be.revertedWithCustomError(
				blackjack,
				'HandNotOwner'
			);
		});

		it('should revert if not PLAYER_TURN', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET);
			const { handId } = await parseHandCreated(blackjack, tx);
			// Still AWAITING_DEAL
			await expect(blackjack.connect(player).hit(handId)).to.be.revertedWithCustomError(
				blackjack,
				'InvalidHandStatus'
			);
		});

		it('should deal one card on hit and stay in PLAYER_TURN if not bust', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);

			// Deal: player gets 5+3=8 (safe hand)
			// word0=4 → rank 5, word1=2 → rank 3
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [4n, 2n]);

			const hitTx = await blackjack.connect(player).hit(handId);
			const hitRequestId = await parseRequestId(blackjack, hitTx, 'HitRequested');

			// Hit card: word=1 → rank 2 (value 2). Total = 5+3+2=10
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, hitRequestId, [1n]);

			const hand = await blackjack.hands(handId);
			expect(hand.status).to.equal(Status.PLAYER_TURN);
			expect(hand.playerCardCount).to.equal(3n);
		});

		it('should auto-resolve on bust', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);

			// Deal: player gets King(10) + Queen(10) = 20
			// word0=12 → rank 13(K=10), word1=11 → rank 12(Q=10)
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [12n, 11n]);

			const hitTx = await blackjack.connect(player).hit(handId);
			const hitRequestId = await parseRequestId(blackjack, hitTx, 'HitRequested');

			// Hit card: word=4 → rank 5 (value 5). Total = 10+10+5=25 → bust
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, hitRequestId, [4n]);

			const hand = await blackjack.hands(handId);
			expect(hand.status).to.equal(Status.RESOLVED);
			expect(hand.result).to.equal(Result.PLAYER_BUST);
			expect(hand.payout).to.equal(0n);
		});
	});

	/* ========== STAND ========== */

	describe('Stand', () => {
		it('should resolve with player win when player > dealer', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET);
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

			const hand = await blackjack.hands(handId);
			expect(hand.status).to.equal(Status.RESOLVED);
			expect(hand.result).to.equal(Result.PLAYER_WIN);
			expect(hand.payout).to.equal(MIN_USDC_BET * 2n);
			expect(await usdc.balanceOf(player.address)).to.equal(
				playerBalanceBefore + MIN_USDC_BET * 2n
			);
		});

		it('should resolve with dealer win when dealer > player', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET);
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

			const hand = await blackjack.hands(handId);
			expect(hand.status).to.equal(Status.RESOLVED);
			expect(hand.result).to.equal(Result.DEALER_WIN);
			expect(hand.payout).to.equal(0n);
		});

		it('should resolve as dealer bust when dealer exceeds 21', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET);
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

			const hand = await blackjack.hands(handId);
			expect(hand.status).to.equal(Status.RESOLVED);
			expect(hand.result).to.equal(Result.DEALER_BUST);
			expect(hand.payout).to.equal(MIN_USDC_BET * 2n);
		});

		it('should resolve as push when tied', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET);
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

			const hand = await blackjack.hands(handId);
			expect(hand.status).to.equal(Status.RESOLVED);
			expect(hand.result).to.equal(Result.PUSH);
			expect(hand.payout).to.equal(MIN_USDC_BET);
		});
	});

	/* ========== DOUBLE DOWN ========== */

	describe('Double Down', () => {
		it('should double bet and resolve', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET * 2n);
			const tx = await blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET);
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

			const hand = await blackjack.hands(handId);
			expect(hand.status).to.equal(Status.RESOLVED);
			expect(hand.result).to.equal(Result.PLAYER_WIN);
			expect(hand.amount).to.equal(MIN_USDC_BET * 2n); // doubled
			expect(hand.payout).to.equal(MIN_USDC_BET * 4n); // 2x doubled amount
		});

		it('should revert if player has more than 2 cards', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET * 2n);
			const tx = await blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET);
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
			const tx = await blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET);
			const { handId } = await parseHandCreated(blackjack, tx);

			await expect(blackjack.connect(player).cancelHand(handId)).to.be.revertedWithCustomError(
				blackjack,
				'CancelTimeoutNotReached'
			);
		});

		it('should cancel after timeout and refund', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET);
			const { handId } = await parseHandCreated(blackjack, tx);

			const balBefore = await usdc.balanceOf(player.address);
			await time.increase(CANCEL_TIMEOUT);

			await expect(blackjack.connect(player).cancelHand(handId)).to.emit(
				blackjack,
				'HandCancelled'
			);

			expect(await usdc.balanceOf(player.address)).to.equal(balBefore + MIN_USDC_BET);
			const hand = await blackjack.hands(handId);
			expect(hand.status).to.equal(Status.CANCELLED);
		});
	});

	/* ========== ADMIN CANCEL ========== */

	describe('adminCancelHand', () => {
		it('should revert for non-resolver', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET);
			const { handId } = await parseHandCreated(blackjack, tx);

			await expect(
				blackjack.connect(secondAccount).adminCancelHand(handId)
			).to.be.revertedWithCustomError(blackjack, 'InvalidSender');
		});

		it('should allow owner to admin cancel', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET);
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

	/* ========== GETTERS ========== */

	describe('Getters', () => {
		it('getMaxPayout should return bet + 6:5 profit', async () => {
			const payout = await blackjack.getMaxPayout(usdcAddress, MIN_USDC_BET);
			expect(payout).to.equal(MIN_USDC_BET + (MIN_USDC_BET * 6n) / 5n);
		});

		it('getUserHands should return correct hand value', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);

			// word0=12→K(10), word1=6→7. Player: 10+7=17
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [12n, 6n]);

			const views = await blackjack.getUserHands(player.address, 0, 1);
			expect(views[0].playerHandValue).to.equal(17n);
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
			await blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET);
			expect(await blackjack.getUserHandCount(player.address)).to.equal(1n);

			await blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET);
			expect(await blackjack.getUserHandCount(player.address)).to.equal(2n);
		});

		it('getUserHands should return hands in reverse chronological order', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET * 3n);
			await blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET);
			await blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET);
			await blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET);

			const views = await blackjack.getUserHands(player.address, 0, 10);
			expect(views.length).to.equal(3);
			expect(views[0].handId).to.equal(3n);
			expect(views[1].handId).to.equal(2n);
			expect(views[2].handId).to.equal(1n);
		});

		it('getUserHands should return empty for offset beyond length', async () => {
			const views = await blackjack.getUserHands(player.address, 100, 10);
			expect(views.length).to.equal(0);
		});

		it('should not include other users hands in getUserHands', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			await blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET);

			expect(await blackjack.getUserHandCount(secondAccount.address)).to.equal(0n);
		});

		it('getUserHands should return full HandView with cards and values', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET);
			const { handId, requestId } = await parseHandCreated(blackjack, tx);

			// Deal cards (blackjack needs 2 random words for initial deal)
			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [9n, 5n]);

			const views = await blackjack.getUserHands(player.address, 0, 10);
			expect(views.length).to.equal(1);
			expect(views[0].handId).to.equal(handId);
			expect(views[0].user).to.equal(player.address);
			expect(views[0].amount).to.equal(MIN_USDC_BET);
			expect(views[0].playerCards.length).to.be.gt(0);
			expect(views[0].dealerCards.length).to.be.gt(0);
			expect(views[0].playerHandValue).to.be.gt(0n);
		});

		it('getRecentHands should return full HandView', async () => {
			await usdc.connect(player).approve(blackjackAddress, MIN_USDC_BET);
			const tx = await blackjack.connect(player).placeBet(usdcAddress, MIN_USDC_BET);
			const { requestId } = await parseHandCreated(blackjack, tx);

			await vrfCoordinator.fulfillRandomWords(blackjackAddress, requestId, [9n, 5n]);

			const views = await blackjack.getRecentHands(0, 10);
			expect(views.length).to.equal(1);
			expect(views[0].handId).to.equal(1n);
			expect(views[0].collateral).to.equal(usdcAddress);
		});

		it('getUserHands should return empty for offset beyond length', async () => {
			const views = await blackjack.getUserHands(player.address, 100, 10);
			expect(views.length).to.equal(0);
		});
	});
});
