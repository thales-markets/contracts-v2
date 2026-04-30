const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const { upgrades, ethers } = require('hardhat');
const { ZERO_ADDRESS } = require('../../../constants/general');

// Mirror of Game enum in CasinoData.sol
const Game = {
	Roulette: 0n,
	Blackjack: 1n,
	Dice: 2n,
	Baccarat: 3n,
	Slots: 4n,
};

// Status values used by Roulette / Dice / Baccarat / Slots
const StdStatus = {
	NONE: 0,
	PENDING: 1,
	RESOLVED: 2,
	CANCELLED: 3,
};

// Status values used by Blackjack
const BjStatus = {
	NONE: 0,
	AWAITING_DEAL: 1,
	PLAYER_TURN: 2,
	AWAITING_HIT: 3,
	AWAITING_STAND: 4,
	AWAITING_DOUBLE: 5,
	RESOLVED: 6,
	CANCELLED: 7,
	AWAITING_SPLIT: 8,
};

const BjResult = {
	NONE: 0,
	PLAYER_BLACKJACK: 1,
	PLAYER_WIN: 2,
	DEALER_WIN: 3,
	PUSH: 4,
	PLAYER_BUST: 5,
	DEALER_BUST: 6,
};

async function deployFixture() {
	const [owner, alice, bob] = await ethers.getSigners();

	const Roulette = await ethers.getContractFactory('MockRouletteGame');
	const roulette = await Roulette.deploy();

	const Blackjack = await ethers.getContractFactory('MockBlackjackGame');
	const blackjack = await Blackjack.deploy();

	const Dice = await ethers.getContractFactory('MockDiceGame');
	const dice = await Dice.deploy();

	const Baccarat = await ethers.getContractFactory('MockBaccaratGame');
	const baccarat = await Baccarat.deploy();

	const Slots = await ethers.getContractFactory('MockSlotsGame');
	const slots = await Slots.deploy();

	const CasinoData = await ethers.getContractFactory('CasinoData');
	const casinoData = await upgrades.deployProxy(CasinoData, [], { initializer: false });
	await casinoData.initialize(
		owner.address,
		await roulette.getAddress(),
		await blackjack.getAddress(),
		await dice.getAddress(),
		await baccarat.getAddress(),
		await slots.getAddress()
	);

	const collateralA = '0x0000000000000000000000000000000000000aaa';
	const collateralB = '0x0000000000000000000000000000000000000bbb';

	return {
		owner,
		alice,
		bob,
		roulette,
		blackjack,
		dice,
		baccarat,
		slots,
		casinoData,
		collateralA,
		collateralB,
	};
}

describe('CasinoData', () => {
	describe('initialization', () => {
		it('stores owner and game addresses', async () => {
			const { owner, casinoData, roulette, blackjack, dice, baccarat, slots } =
				await loadFixture(deployFixture);
			expect(await casinoData.owner()).to.equal(owner.address);
			expect(await casinoData.roulette()).to.equal(await roulette.getAddress());
			expect(await casinoData.blackjack()).to.equal(await blackjack.getAddress());
			expect(await casinoData.dice()).to.equal(await dice.getAddress());
			expect(await casinoData.baccarat()).to.equal(await baccarat.getAddress());
			expect(await casinoData.slots()).to.equal(await slots.getAddress());
		});
	});

	describe('empty state', () => {
		it('returns empty arrays when no bets exist', async () => {
			const { casinoData, alice } = await loadFixture(deployFixture);
			for (const g of [Game.Roulette, Game.Blackjack, Game.Dice, Game.Baccarat, Game.Slots]) {
				expect((await casinoData.getRecentBets(g, 0, 50)).length).to.equal(0);
				expect((await casinoData.getUserBets(g, alice.address, 0, 50)).length).to.equal(0);
			}
		});

		it('returns empty arrays for unwired games (zero address)', async () => {
			const { owner, alice, roulette, blackjack, dice, baccarat } =
				await loadFixture(deployFixture);
			const CasinoData = await ethers.getContractFactory('CasinoData');
			const sparse = await upgrades.deployProxy(CasinoData, [], { initializer: false });
			await sparse.initialize(
				owner.address,
				await roulette.getAddress(),
				await blackjack.getAddress(),
				await dice.getAddress(),
				await baccarat.getAddress(),
				ZERO_ADDRESS
			);
			expect(await sparse.getNextId(Game.Slots)).to.equal(0);
			expect((await sparse.getRecentBets(Game.Slots, 0, 50)).length).to.equal(0);
			expect((await sparse.getUserBets(Game.Slots, alice.address, 0, 50)).length).to.equal(0);
		});
	});

	describe('getNextId', () => {
		it('forwards the per-game next id', async () => {
			const { casinoData, roulette, blackjack, dice, baccarat, slots, alice, collateralA } =
				await loadFixture(deployFixture);
			await roulette.setBet(1, alice.address, collateralA, 100, 0, StdStatus.PENDING, false, false);
			await roulette.setBet(2, alice.address, collateralA, 100, 0, StdStatus.PENDING, false, false);
			await blackjack.setHand(
				1,
				alice.address,
				collateralA,
				100,
				0,
				BjStatus.AWAITING_DEAL,
				BjResult.NONE,
				false
			);
			await dice.setBet(7, alice.address, collateralA, 100, 0, StdStatus.PENDING, false, false);
			await baccarat.setBet(
				1,
				alice.address,
				collateralA,
				100,
				0,
				StdStatus.PENDING,
				false,
				false,
				false
			);
			await slots.setSpin(1, alice.address, collateralA, 100, 0, StdStatus.PENDING, false, false);

			expect(await casinoData.getNextId(Game.Roulette)).to.equal(3);
			expect(await casinoData.getNextId(Game.Blackjack)).to.equal(2);
			expect(await casinoData.getNextId(Game.Dice)).to.equal(8);
			expect(await casinoData.getNextId(Game.Baccarat)).to.equal(2);
			expect(await casinoData.getNextId(Game.Slots)).to.equal(2);
		});
	});

	describe('status normalization', () => {
		it('maps Roulette / Dice / Baccarat / Slots status to resolved/cancelled', async () => {
			const { casinoData, roulette, dice, baccarat, slots, alice, collateralA } =
				await loadFixture(deployFixture);
			// Roulette: pending, resolved-won, resolved-lost, cancelled
			await roulette.setBet(1, alice.address, collateralA, 100, 0, StdStatus.PENDING, false, false);
			await roulette.setBet(
				2,
				alice.address,
				collateralA,
				100,
				200,
				StdStatus.RESOLVED,
				true,
				false
			);
			await roulette.setBet(
				3,
				alice.address,
				collateralA,
				100,
				0,
				StdStatus.RESOLVED,
				false,
				false
			);
			await roulette.setBet(
				4,
				alice.address,
				collateralA,
				100,
				100,
				StdStatus.CANCELLED,
				false,
				false
			);

			const recent = await casinoData.getRecentBets(Game.Roulette, 0, 10);
			// Reverse-chronological order: id 4, 3, 2, 1
			expect(recent.length).to.equal(4);
			// id 4 cancelled
			expect(recent[0].cancelled).to.equal(true);
			expect(recent[0].resolved).to.equal(false);
			// id 3 resolved-lost
			expect(recent[1].resolved).to.equal(true);
			expect(recent[1].cancelled).to.equal(false);
			expect(recent[1].won).to.equal(false);
			// id 2 resolved-won
			expect(recent[2].resolved).to.equal(true);
			expect(recent[2].won).to.equal(true);
			expect(recent[2].payout).to.equal(200);
			// id 1 pending
			expect(recent[3].resolved).to.equal(false);
			expect(recent[3].cancelled).to.equal(false);
			expect(recent[3].won).to.equal(false);

			// Other "standard-status" games normalize identically
			await dice.setBet(1, alice.address, collateralA, 100, 0, StdStatus.CANCELLED, false, false);
			const diceRec = await casinoData.getRecentBets(Game.Dice, 0, 10);
			expect(diceRec[0].cancelled).to.equal(true);

			await baccarat.setBet(
				1,
				alice.address,
				collateralA,
				100,
				0,
				StdStatus.CANCELLED,
				false,
				false,
				false
			);
			const bacRec = await casinoData.getRecentBets(Game.Baccarat, 0, 10);
			expect(bacRec[0].cancelled).to.equal(true);

			await slots.setSpin(1, alice.address, collateralA, 100, 0, StdStatus.CANCELLED, false, false);
			const slotRec = await casinoData.getRecentBets(Game.Slots, 0, 10);
			expect(slotRec[0].cancelled).to.equal(true);
		});

		it('maps Blackjack status enum (RESOLVED=6, CANCELLED=7)', async () => {
			const { casinoData, blackjack, alice, collateralA } = await loadFixture(deployFixture);
			await blackjack.setHand(
				1,
				alice.address,
				collateralA,
				100,
				0,
				BjStatus.PLAYER_TURN,
				BjResult.NONE,
				false
			);
			await blackjack.setHand(
				2,
				alice.address,
				collateralA,
				100,
				200,
				BjStatus.RESOLVED,
				BjResult.PLAYER_WIN,
				false
			);
			await blackjack.setHand(
				3,
				alice.address,
				collateralA,
				100,
				100,
				BjStatus.CANCELLED,
				BjResult.NONE,
				false
			);

			const recent = await casinoData.getRecentBets(Game.Blackjack, 0, 10);
			expect(recent.length).to.equal(3);
			// id 3 — cancelled
			expect(recent[0].cancelled).to.equal(true);
			expect(recent[0].resolved).to.equal(false);
			// id 2 — resolved + win
			expect(recent[1].resolved).to.equal(true);
			expect(recent[1].won).to.equal(true);
			// id 1 — in-play
			expect(recent[2].resolved).to.equal(false);
			expect(recent[2].cancelled).to.equal(false);
		});
	});

	describe('win and push detection', () => {
		it('Baccarat push is exposed and excluded from won', async () => {
			const { casinoData, baccarat, alice, collateralA } = await loadFixture(deployFixture);
			// Push: refund payout, contract reports won=false isPush=true
			await baccarat.setBet(
				1,
				alice.address,
				collateralA,
				100,
				100,
				StdStatus.RESOLVED,
				false,
				true,
				false
			);
			// Normal win
			await baccarat.setBet(
				2,
				alice.address,
				collateralA,
				100,
				195,
				StdStatus.RESOLVED,
				true,
				false,
				false
			);

			const recent = await casinoData.getRecentBets(Game.Baccarat, 0, 10);
			// id 2 first
			expect(recent[0].won).to.equal(true);
			expect(recent[0].isPush).to.equal(false);
			// id 1 push
			expect(recent[1].won).to.equal(false);
			expect(recent[1].isPush).to.equal(true);
		});

		it('Blackjack PUSH result maps isPush=true and won=false', async () => {
			const { casinoData, blackjack, alice, collateralA } = await loadFixture(deployFixture);
			await blackjack.setHand(
				1,
				alice.address,
				collateralA,
				100,
				100,
				BjStatus.RESOLVED,
				BjResult.PUSH,
				false
			);
			const recent = await casinoData.getRecentBets(Game.Blackjack, 0, 10);
			expect(recent[0].isPush).to.equal(true);
			expect(recent[0].won).to.equal(false);
			expect(recent[0].resolved).to.equal(true);
		});

		it('Blackjack winning results (PLAYER_BLACKJACK, PLAYER_WIN, DEALER_BUST) all map to won=true', async () => {
			const { casinoData, blackjack, alice, collateralA } = await loadFixture(deployFixture);
			await blackjack.setHand(
				1,
				alice.address,
				collateralA,
				100,
				250,
				BjStatus.RESOLVED,
				BjResult.PLAYER_BLACKJACK,
				false
			);
			await blackjack.setHand(
				2,
				alice.address,
				collateralA,
				100,
				200,
				BjStatus.RESOLVED,
				BjResult.PLAYER_WIN,
				false
			);
			await blackjack.setHand(
				3,
				alice.address,
				collateralA,
				100,
				200,
				BjStatus.RESOLVED,
				BjResult.DEALER_BUST,
				false
			);
			// Losing result
			await blackjack.setHand(
				4,
				alice.address,
				collateralA,
				100,
				0,
				BjStatus.RESOLVED,
				BjResult.DEALER_WIN,
				false
			);
			await blackjack.setHand(
				5,
				alice.address,
				collateralA,
				100,
				0,
				BjStatus.RESOLVED,
				BjResult.PLAYER_BUST,
				false
			);

			const recent = await casinoData.getRecentBets(Game.Blackjack, 0, 10);
			// recent reversed: id 5..1
			expect(recent[0].won).to.equal(false); // PLAYER_BUST
			expect(recent[1].won).to.equal(false); // DEALER_WIN
			expect(recent[2].won).to.equal(true); // DEALER_BUST
			expect(recent[3].won).to.equal(true); // PLAYER_WIN
			expect(recent[4].won).to.equal(true); // PLAYER_BLACKJACK
		});

		it('Roulette/Dice/Slots are never marked as push', async () => {
			const { casinoData, roulette, dice, slots, alice, collateralA } =
				await loadFixture(deployFixture);
			await roulette.setBet(
				1,
				alice.address,
				collateralA,
				100,
				200,
				StdStatus.RESOLVED,
				true,
				false
			);
			await dice.setBet(1, alice.address, collateralA, 100, 200, StdStatus.RESOLVED, true, false);
			await slots.setSpin(1, alice.address, collateralA, 100, 200, StdStatus.RESOLVED, true, false);
			expect((await casinoData.getRecentBets(Game.Roulette, 0, 10))[0].isPush).to.equal(false);
			expect((await casinoData.getRecentBets(Game.Dice, 0, 10))[0].isPush).to.equal(false);
			expect((await casinoData.getRecentBets(Game.Slots, 0, 10))[0].isPush).to.equal(false);
		});
	});

	describe('Blackjack split expansion', () => {
		it('expands a split hand into two records with per-hand amounts and results', async () => {
			const { casinoData, blackjack, alice, collateralA } = await loadFixture(deployFixture);
			// Hand 1 wins 2x (PLAYER_WIN), hand 2 pushes. Combined payout = 200 + 100 = 300
			await blackjack.setHand(
				1,
				alice.address,
				collateralA,
				100,
				300,
				BjStatus.RESOLVED,
				BjResult.PLAYER_WIN,
				false
			);
			await blackjack.setSplit(1, 100, 100, BjResult.PUSH);

			const recent = await casinoData.getRecentBets(Game.Blackjack, 0, 10);
			expect(recent.length).to.equal(2);

			// Hand 1: amount = base.amount, payout = base.payout - payout2 = 200
			expect(recent[0].amount).to.equal(100);
			expect(recent[0].payout).to.equal(200);
			expect(recent[0].won).to.equal(true);
			expect(recent[0].isPush).to.equal(false);

			// Hand 2: amount = amount2, payout = payout2, result = result2
			expect(recent[1].amount).to.equal(100);
			expect(recent[1].payout).to.equal(100);
			expect(recent[1].won).to.equal(false);
			expect(recent[1].isPush).to.equal(true);
		});

		it('split records share user/collateral/free-bet flag', async () => {
			const { casinoData, blackjack, alice, collateralA } = await loadFixture(deployFixture);
			await blackjack.setHand(
				1,
				alice.address,
				collateralA,
				100,
				300,
				BjStatus.RESOLVED,
				BjResult.PLAYER_WIN,
				true
			);
			await blackjack.setSplit(1, 100, 100, BjResult.DEALER_WIN);

			const recent = await casinoData.getRecentBets(Game.Blackjack, 0, 10);
			for (const rec of recent) {
				expect(rec.user).to.equal(alice.address);
				expect(rec.collateral).to.equal(ethers.getAddress(collateralA));
				expect(rec.isFreeBet).to.equal(true);
				expect(rec.resolved).to.equal(true);
				expect(rec.cancelled).to.equal(false);
			}
		});

		it('mixes split and unsplit hands within one page (length up to 2x limit)', async () => {
			const { casinoData, blackjack, alice, collateralA } = await loadFixture(deployFixture);
			// id 1: split
			await blackjack.setHand(
				1,
				alice.address,
				collateralA,
				100,
				200,
				BjStatus.RESOLVED,
				BjResult.PLAYER_WIN,
				false
			);
			await blackjack.setSplit(1, 100, 0, BjResult.DEALER_WIN);
			// id 2: unsplit
			await blackjack.setHand(
				2,
				alice.address,
				collateralA,
				50,
				100,
				BjStatus.RESOLVED,
				BjResult.PLAYER_WIN,
				false
			);
			// id 3: split
			await blackjack.setHand(
				3,
				alice.address,
				collateralA,
				75,
				150,
				BjStatus.RESOLVED,
				BjResult.PUSH,
				false
			);
			await blackjack.setSplit(3, 75, 75, BjResult.PUSH);

			const recent = await casinoData.getRecentBets(Game.Blackjack, 0, 10);
			// 3 hands → 2 + 1 + 2 = 5 records
			expect(recent.length).to.equal(5);
		});
	});

	describe('free-bet plumbing', () => {
		it('is exposed across all games', async () => {
			const { casinoData, roulette, blackjack, dice, baccarat, slots, alice, collateralA } =
				await loadFixture(deployFixture);
			await roulette.setBet(1, alice.address, collateralA, 100, 0, StdStatus.PENDING, false, true);
			await blackjack.setHand(
				1,
				alice.address,
				collateralA,
				100,
				0,
				BjStatus.AWAITING_DEAL,
				BjResult.NONE,
				true
			);
			await dice.setBet(1, alice.address, collateralA, 100, 0, StdStatus.PENDING, false, true);
			await baccarat.setBet(
				1,
				alice.address,
				collateralA,
				100,
				0,
				StdStatus.PENDING,
				false,
				false,
				true
			);
			await slots.setSpin(1, alice.address, collateralA, 100, 0, StdStatus.PENDING, false, true);

			expect((await casinoData.getRecentBets(Game.Roulette, 0, 10))[0].isFreeBet).to.equal(true);
			expect((await casinoData.getRecentBets(Game.Blackjack, 0, 10))[0].isFreeBet).to.equal(true);
			expect((await casinoData.getRecentBets(Game.Dice, 0, 10))[0].isFreeBet).to.equal(true);
			expect((await casinoData.getRecentBets(Game.Baccarat, 0, 10))[0].isFreeBet).to.equal(true);
			expect((await casinoData.getRecentBets(Game.Slots, 0, 10))[0].isFreeBet).to.equal(true);
		});
	});

	describe('pagination', () => {
		it('per-user paging reverses order and respects offset/limit', async () => {
			const { casinoData, roulette, alice, bob, collateralA } = await loadFixture(deployFixture);
			// alice 1, 3, 5 ; bob 2, 4
			await roulette.setBet(1, alice.address, collateralA, 100, 0, StdStatus.PENDING, false, false);
			await roulette.setBet(2, bob.address, collateralA, 100, 0, StdStatus.PENDING, false, false);
			await roulette.setBet(3, alice.address, collateralA, 100, 0, StdStatus.PENDING, false, false);
			await roulette.setBet(4, bob.address, collateralA, 100, 0, StdStatus.PENDING, false, false);
			await roulette.setBet(5, alice.address, collateralA, 100, 0, StdStatus.PENDING, false, false);

			const aliceAll = await casinoData.getUserBets(Game.Roulette, alice.address, 0, 50);
			expect(aliceAll.length).to.equal(3);
			// ordering matches getUserBetIds (most recent first)

			// Page 0: limit 2 → most recent 2 alice bets
			const aliceP0 = await casinoData.getUserBets(Game.Roulette, alice.address, 0, 2);
			expect(aliceP0.length).to.equal(2);

			// Page 1: offset 2 → 1 remaining alice bet
			const aliceP1 = await casinoData.getUserBets(Game.Roulette, alice.address, 2, 2);
			expect(aliceP1.length).to.equal(1);

			// All alice records belong to alice
			for (const r of aliceAll) expect(r.user).to.equal(alice.address);

			// Recent across both users: 5 bets
			const recent = await casinoData.getRecentBets(Game.Roulette, 0, 50);
			expect(recent.length).to.equal(5);
		});

		it('offset beyond available returns empty', async () => {
			const { casinoData, roulette, alice, collateralA } = await loadFixture(deployFixture);
			await roulette.setBet(1, alice.address, collateralA, 100, 0, StdStatus.PENDING, false, false);
			expect((await casinoData.getRecentBets(Game.Roulette, 5, 10)).length).to.equal(0);
			expect((await casinoData.getUserBets(Game.Roulette, alice.address, 5, 10)).length).to.equal(
				0
			);
		});
	});

	describe('getRecentBetsAllGames', () => {
		it('returns one array per game indexed by enum', async () => {
			const { casinoData, roulette, dice, alice, collateralA } = await loadFixture(deployFixture);
			await roulette.setBet(1, alice.address, collateralA, 100, 0, StdStatus.PENDING, false, false);
			await dice.setBet(1, alice.address, collateralA, 200, 0, StdStatus.PENDING, false, false);

			const all = await casinoData.getRecentBetsAllGames(0, 10);
			expect(all.length).to.equal(5);
			expect(all[Number(Game.Roulette)].length).to.equal(1);
			expect(all[Number(Game.Roulette)][0].amount).to.equal(100);
			expect(all[Number(Game.Dice)].length).to.equal(1);
			expect(all[Number(Game.Dice)][0].amount).to.equal(200);
			expect(all[Number(Game.Blackjack)].length).to.equal(0);
			expect(all[Number(Game.Baccarat)].length).to.equal(0);
			expect(all[Number(Game.Slots)].length).to.equal(0);
		});
	});

	describe('owner setters', () => {
		it('only owner can repoint a game', async () => {
			const { casinoData, alice } = await loadFixture(deployFixture);
			const newAddr = '0x0000000000000000000000000000000000001234';
			await expect(casinoData.connect(alice).setRoulette(newAddr)).to.be.revertedWith(
				'Only the contract owner may perform this action'
			);
		});

		it('owner can repoint and emits an event', async () => {
			const { casinoData, owner } = await loadFixture(deployFixture);
			const newAddr = '0x0000000000000000000000000000000000001234';
			await expect(casinoData.connect(owner).setBlackjack(newAddr))
				.to.emit(casinoData, 'GameAddressChanged')
				.withArgs(Number(Game.Blackjack), newAddr);
			expect(await casinoData.blackjack()).to.equal(newAddr);
		});

		it('owner can clear an address (zero) and reads then return empty', async () => {
			const { casinoData, owner, alice } = await loadFixture(deployFixture);
			await casinoData.connect(owner).setSlots(ZERO_ADDRESS);
			expect(await casinoData.getNextId(Game.Slots)).to.equal(0);
			expect((await casinoData.getRecentBets(Game.Slots, 0, 10)).length).to.equal(0);
			expect((await casinoData.getUserBets(Game.Slots, alice.address, 0, 10)).length).to.equal(0);
		});
	});

	describe('Roulette full reader', () => {
		it('returns synthesized 1-element pick array for a single-pick bet, with result and placedAt', async () => {
			const { casinoData, roulette, alice, collateralA } = await loadFixture(deployFixture);
			await roulette.setBet(
				1,
				alice.address,
				collateralA,
				1000,
				1800,
				StdStatus.RESOLVED,
				true,
				false
			);
			await roulette.setBetExtras(1, 17 /* result */, 12345 /* placedAt */, []);

			const recs = await casinoData.getRecentRouletteBetsFull(0, 10);
			expect(recs.length).to.equal(1);
			expect(recs[0].betId).to.equal(1);
			expect(recs[0].user).to.equal(alice.address);
			expect(recs[0].collateral).to.equal(collateralA);
			expect(recs[0].amount).to.equal(1000);
			expect(recs[0].payout).to.equal(1800);
			expect(recs[0].placedAt).to.equal(12345);
			expect(recs[0].resolved).to.equal(true);
			expect(recs[0].cancelled).to.equal(false);
			expect(recs[0].won).to.equal(true);
			expect(recs[0].result).to.equal(17);
			expect(recs[0].picks.length).to.equal(1);
			expect(recs[0].picks[0].amount).to.equal(1000);
			expect(recs[0].picks[0].payout).to.equal(1800);
			expect(recs[0].picks[0].won).to.equal(true);
		});

		it('returns full pick array and primary betType/selection from picks[0]', async () => {
			const { casinoData, roulette, alice, collateralA } = await loadFixture(deployFixture);
			await roulette.setBet(
				2,
				alice.address,
				collateralA,
				300,
				0,
				StdStatus.RESOLVED,
				false,
				false
			);
			const picks = [
				{ betType: 4, selection: 1, won: false, amount: 100, reservedProfit: 0, payout: 0 },
				{ betType: 1, selection: 0, won: false, amount: 100, reservedProfit: 0, payout: 0 },
				{ betType: 0, selection: 7, won: false, amount: 100, reservedProfit: 0, payout: 0 },
			];
			await roulette.setBetExtras(2, 23, 9999, picks);

			const recs = await casinoData.getRecentRouletteBetsFull(0, 10);
			expect(recs[0].picks.length).to.equal(3);
			expect(recs[0].primaryBetType).to.equal(4);
			expect(recs[0].primarySelection).to.equal(1);
			expect(recs[0].picks[2].selection).to.equal(7);
			expect(recs[0].result).to.equal(23);
		});

		it('user-scoped reader filters by user and returns same shape', async () => {
			const { casinoData, roulette, alice, bob, collateralA } = await loadFixture(deployFixture);
			await roulette.setBet(1, alice.address, collateralA, 100, 0, StdStatus.PENDING, false, false);
			await roulette.setBet(2, bob.address, collateralA, 200, 0, StdStatus.PENDING, false, false);
			await roulette.setBet(3, alice.address, collateralA, 300, 0, StdStatus.PENDING, false, false);

			const aliceRecs = await casinoData.getUserRouletteBetsFull(alice.address, 0, 10);
			expect(aliceRecs.length).to.equal(2);
			expect(aliceRecs[0].betId).to.equal(3);
			expect(aliceRecs[1].betId).to.equal(1);
		});

		it('by-ids returns ordered records and handles missing ids as zero-filled', async () => {
			const { casinoData, roulette, alice, collateralA } = await loadFixture(deployFixture);
			await roulette.setBet(
				1,
				alice.address,
				collateralA,
				100,
				0,
				StdStatus.RESOLVED,
				false,
				false
			);
			await roulette.setBet(
				5,
				alice.address,
				collateralA,
				500,
				0,
				StdStatus.RESOLVED,
				false,
				false
			);
			const recs = await casinoData.getRouletteBetsByIds([5, 99, 1]);
			expect(recs.length).to.equal(3);
			expect(recs[0].betId).to.equal(5);
			expect(recs[0].amount).to.equal(500);
			expect(recs[1].betId).to.equal(99);
			expect(recs[1].user).to.equal(ZERO_ADDRESS);
			expect(recs[1].amount).to.equal(0);
			expect(recs[2].betId).to.equal(1);
			expect(recs[2].amount).to.equal(100);
		});
	});

	describe('Blackjack full reader', () => {
		it('returns ONE record per handId for unsplit hands (no expansion)', async () => {
			const { casinoData, blackjack, alice, collateralA } = await loadFixture(deployFixture);
			await blackjack.setHand(
				1,
				alice.address,
				collateralA,
				100,
				200,
				BjStatus.RESOLVED,
				BjResult.PLAYER_WIN,
				false
			);
			await blackjack.setHand(
				2,
				alice.address,
				collateralA,
				50,
				0,
				BjStatus.RESOLVED,
				BjResult.DEALER_WIN,
				false
			);

			const recs = await casinoData.getRecentBlackjackHandsFull(0, 10);
			expect(recs.length).to.equal(2);
			expect(recs[0].handId).to.equal(2);
			expect(recs[1].handId).to.equal(1);
			expect(recs[1].status).to.equal(BjStatus.RESOLVED);
			expect(recs[1].result).to.equal(BjResult.PLAYER_WIN);
			expect(recs[1].isSplit).to.equal(false);
			expect(recs[1].amount2).to.equal(0);
		});

		it('split hand stays as ONE record with hand2 fields populated (no expansion)', async () => {
			const { casinoData, blackjack, alice, collateralA } = await loadFixture(deployFixture);
			await blackjack.setHand(
				1,
				alice.address,
				collateralA,
				100,
				350,
				BjStatus.RESOLVED,
				BjResult.PLAYER_WIN,
				false
			);
			await blackjack.setSplit(1, 100, 250, BjResult.PLAYER_BLACKJACK);
			await blackjack.setSplitExtras(1, true /* isDoubled2 */, [10, 11]);

			const recs = await casinoData.getRecentBlackjackHandsFull(0, 10);
			expect(recs.length).to.equal(1); // NOT 2 — split is not expanded here
			expect(recs[0].isSplit).to.equal(true);
			expect(recs[0].amount).to.equal(100);
			expect(recs[0].amount2).to.equal(100);
			expect(recs[0].payout).to.equal(350); // combined payout from base
			expect(recs[0].result).to.equal(BjResult.PLAYER_WIN);
			expect(recs[0].result2).to.equal(BjResult.PLAYER_BLACKJACK);
			expect(recs[0].isDoubled2).to.equal(true);
			expect(recs[0].player2Cards.length).to.equal(2);
			expect(Number(recs[0].player2Cards[0])).to.equal(10);
		});

		it('exposes playerCards/dealerCards/lastRequestAt/isDoubledDown', async () => {
			const { casinoData, blackjack, alice, collateralA } = await loadFixture(deployFixture);
			await blackjack.setHand(
				1,
				alice.address,
				collateralA,
				100,
				0,
				BjStatus.PLAYER_TURN,
				BjResult.NONE,
				false
			);
			await blackjack.setHandExtras(
				1,
				true /* isDoubledDown */,
				1111 /* placedAt */,
				2222 /* lastRequestAt */,
				[1, 2, 3],
				[7, 8]
			);
			const recs = await casinoData.getRecentBlackjackHandsFull(0, 10);
			expect(recs[0].isDoubledDown).to.equal(true);
			expect(recs[0].placedAt).to.equal(1111);
			expect(recs[0].lastRequestAt).to.equal(2222);
			expect(recs[0].playerCards.length).to.equal(3);
			expect(recs[0].dealerCards.length).to.equal(2);
			expect(Number(recs[0].playerCards[2])).to.equal(3);
			expect(Number(recs[0].dealerCards[1])).to.equal(8);
			expect(recs[0].player2Cards.length).to.equal(0);
		});

		it('by-ids returns missing handIds as zero-filled', async () => {
			const { casinoData, blackjack, alice, collateralA } = await loadFixture(deployFixture);
			await blackjack.setHand(
				7,
				alice.address,
				collateralA,
				100,
				0,
				BjStatus.RESOLVED,
				BjResult.DEALER_WIN,
				false
			);
			const recs = await casinoData.getBlackjackHandsByIds([7, 99]);
			expect(recs.length).to.equal(2);
			expect(recs[0].handId).to.equal(7);
			expect(recs[1].handId).to.equal(99);
			expect(recs[1].user).to.equal(ZERO_ADDRESS);
			expect(recs[1].status).to.equal(BjStatus.NONE);
		});
	});

	describe('Dice full reader', () => {
		it('exposes betType/target/result on each record', async () => {
			const { casinoData, dice, alice, collateralA } = await loadFixture(deployFixture);
			await dice.setBet(1, alice.address, collateralA, 100, 200, StdStatus.RESOLVED, true, false);
			await dice.setBetExtras(
				1,
				1 /* ROLL_OVER */,
				50 /* target */,
				73 /* result */,
				555 /* placedAt */
			);

			const recs = await casinoData.getRecentDiceBetsFull(0, 10);
			expect(recs.length).to.equal(1);
			expect(recs[0].betType).to.equal(1);
			expect(recs[0].target).to.equal(50);
			expect(recs[0].result).to.equal(73);
			expect(recs[0].won).to.equal(true);
			expect(recs[0].placedAt).to.equal(555);
		});

		it('user-scoped reader and by-ids', async () => {
			const { casinoData, dice, alice, bob, collateralA } = await loadFixture(deployFixture);
			await dice.setBet(1, alice.address, collateralA, 100, 0, StdStatus.RESOLVED, false, false);
			await dice.setBet(2, bob.address, collateralA, 200, 0, StdStatus.RESOLVED, false, false);
			expect((await casinoData.getUserDiceBetsFull(alice.address, 0, 10)).length).to.equal(1);
			const byIds = await casinoData.getDiceBetsByIds([2, 1, 99]);
			expect(byIds.length).to.equal(3);
			expect(byIds[2].betId).to.equal(99);
			expect(byIds[2].amount).to.equal(0);
		});
	});

	describe('Baccarat full reader', () => {
		it('exposes betType/playerTotal/bankerTotal/cards', async () => {
			const { casinoData, baccarat, alice, collateralA } = await loadFixture(deployFixture);
			await baccarat.setBet(
				1,
				alice.address,
				collateralA,
				100,
				195,
				StdStatus.RESOLVED,
				true,
				false,
				false
			);
			await baccarat.setBetExtras(
				1,
				1 /* BANKER */,
				7 /* playerTotal */,
				9 /* bankerTotal */,
				[3, 4, 5, 6, 0, 0],
				100
			);

			const recs = await casinoData.getRecentBaccaratBetsFull(0, 10);
			expect(recs[0].betType).to.equal(1);
			expect(recs[0].playerTotal).to.equal(7);
			expect(recs[0].bankerTotal).to.equal(9);
			expect(recs[0].won).to.equal(true);
			expect(recs[0].isPush).to.equal(false);
			expect(recs[0].cards.length).to.equal(6);
			expect(Number(recs[0].cards[3])).to.equal(6);
			expect(Number(recs[0].cards[4])).to.equal(0); // 4-card hand
		});

		it('push records have won=false and isPush=true', async () => {
			const { casinoData, baccarat, alice, collateralA } = await loadFixture(deployFixture);
			await baccarat.setBet(
				1,
				alice.address,
				collateralA,
				100,
				100,
				StdStatus.RESOLVED,
				true,
				true,
				false
			);
			const recs = await casinoData.getRecentBaccaratBetsFull(0, 10);
			expect(recs[0].won).to.equal(false);
			expect(recs[0].isPush).to.equal(true);
		});
	});

	describe('Slots full reader', () => {
		it('exposes the 3-reel result', async () => {
			const { casinoData, slots, alice, collateralA } = await loadFixture(deployFixture);
			await slots.setSpin(1, alice.address, collateralA, 100, 300, StdStatus.RESOLVED, true, false);
			await slots.setSpinExtras(1, [7, 7, 7], 12345);
			const recs = await casinoData.getRecentSlotsSpinsFull(0, 10);
			expect(recs[0].won).to.equal(true);
			expect(recs[0].placedAt).to.equal(12345);
			expect(Number(recs[0].reels[0])).to.equal(7);
			expect(Number(recs[0].reels[1])).to.equal(7);
			expect(Number(recs[0].reels[2])).to.equal(7);
		});
	});

	describe('full reader limits and unwired-game safety', () => {
		it('caps page limit at 200 silently', async () => {
			const { casinoData, dice, alice, collateralA } = await loadFixture(deployFixture);
			for (let i = 1; i <= 5; ++i) {
				await dice.setBet(i, alice.address, collateralA, 100, 0, StdStatus.RESOLVED, false, false);
			}
			// Asking for 9999 should not revert; it should clamp to 200 and return all 5
			const recs = await casinoData.getRecentDiceBetsFull(0, 9999);
			expect(recs.length).to.equal(5);
		});

		it('reverts when by-ids exceeds 100', async () => {
			const { casinoData } = await loadFixture(deployFixture);
			const tooMany = Array.from({ length: 101 }, (_, i) => i + 1);
			await expect(casinoData.getDiceBetsByIds(tooMany)).to.be.revertedWith('ids too long');
		});

		it('all five full readers return empty arrays when their game is unwired', async () => {
			const { casinoData, owner, alice } = await loadFixture(deployFixture);
			await casinoData.connect(owner).setRoulette(ZERO_ADDRESS);
			await casinoData.connect(owner).setBlackjack(ZERO_ADDRESS);
			await casinoData.connect(owner).setDice(ZERO_ADDRESS);
			await casinoData.connect(owner).setBaccarat(ZERO_ADDRESS);
			await casinoData.connect(owner).setSlots(ZERO_ADDRESS);

			expect((await casinoData.getRecentRouletteBetsFull(0, 10)).length).to.equal(0);
			expect((await casinoData.getUserRouletteBetsFull(alice.address, 0, 10)).length).to.equal(0);
			expect((await casinoData.getRouletteBetsByIds([1])).length).to.equal(0);
			expect((await casinoData.getRecentBlackjackHandsFull(0, 10)).length).to.equal(0);
			expect((await casinoData.getUserBlackjackHandsFull(alice.address, 0, 10)).length).to.equal(0);
			expect((await casinoData.getBlackjackHandsByIds([1])).length).to.equal(0);
			expect((await casinoData.getRecentDiceBetsFull(0, 10)).length).to.equal(0);
			expect((await casinoData.getUserDiceBetsFull(alice.address, 0, 10)).length).to.equal(0);
			expect((await casinoData.getDiceBetsByIds([1])).length).to.equal(0);
			expect((await casinoData.getRecentBaccaratBetsFull(0, 10)).length).to.equal(0);
			expect((await casinoData.getUserBaccaratBetsFull(alice.address, 0, 10)).length).to.equal(0);
			expect((await casinoData.getBaccaratBetsByIds([1])).length).to.equal(0);
			expect((await casinoData.getRecentSlotsSpinsFull(0, 10)).length).to.equal(0);
			expect((await casinoData.getUserSlotsSpinsFull(alice.address, 0, 10)).length).to.equal(0);
			expect((await casinoData.getSlotsSpinsByIds([1])).length).to.equal(0);
		});
	});
});
