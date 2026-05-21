// ============================================================================
// HiLo Cross-Validation — multi-round game. Each bet runs through 1+ guess rounds
// then either busts or cashes out. Per-bet asserts that contract state (lastCard,
// currentMultiplier, payout) matches off-chain prediction at every round.
//
// Strategy: always ABOVE (symmetric so doesn't affect edge). Cashout target K
// cycles 1/2/3 across bets. Off-chain predicts the card from `word % 52` and the
// rank-vs-midpoint comparison; multiplier compounding by factor = (12 - 13×HE)/6.
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
const BET_AMOUNT = 3n * USDC_UNIT;

const N_BETS = Number(process.env.N_BETS || 1000);
const PROGRESS_EVERY = 100;

const HE_E18 = 2n * 10n ** 16n; // 2%
const MAX_MULT_E18 = 25n * ONE; // contract default
const MIDPOINT_RANK = 6;
const Direction = { ABOVE: 0, BELOW: 1 };
const BetStatus = { NONE: 0, PLAYER_TURN: 1, AWAITING_NEXT_CARD: 2, RESOLVED: 3, CANCELLED: 4 };
const Outcome = { NONE: 0, CASHED_OUT: 1, WRONG_GUESS: 2 };

const FACTOR_E18 = (12n * ONE - 13n * HE_E18) / 6n; // ≈ 1.9567e18

function wordFromSeed(seed) {
	return BigInt('0x' + ethers.id(`hilo-xval-${seed}`).slice(2));
}

function rank(card) {
	return Math.floor(card / 4);
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
			freeBetsHolder: await fbh.getAddress(),
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

	const HiLo = await ethers.getContractFactory('HiLo');
	const hilo = await upgrades.deployProxy(HiLo, [], { initializer: false });
	const hiloAddr = await hilo.getAddress();
	await hilo.initialize(owner.address, coreAddr, managerAddr);
	await core.registerGame(hiloAddr);
	await core.setMaxNetLossPerGameUsd(hiloAddr, ethers.parseEther('5000000'));

	await usdc.setDefaultAmount(1_000_000n * USDC_UNIT);
	await usdc.mintForUser(owner.address);
	await usdc.transfer(coreAddr, 200_000n * USDC_UNIT);
	await usdc.transfer(player.address, 100_000n * USDC_UNIT);
	await usdc.connect(player).approve(coreAddr, ethers.MaxUint256);

	return { hilo, hiloAddr, vrf, core, coreAddr, usdc, usdcAddr, player };
}

// Off-chain step: given current mult & direction, apply round outcome from word
// Returns { newCard, newMult, outcome: 'HIT'|'PUSH'|'BUST' }
function applyRoundOffChain(currentMultE18, direction, word) {
	const newCard = Number(BigInt(word) % 52n);
	const r = rank(newCard);
	if (r === MIDPOINT_RANK) {
		return { newCard, newMultE18: currentMultE18, outcome: 'PUSH' };
	}
	const correct =
		(direction === Direction.ABOVE && r > MIDPOINT_RANK) ||
		(direction === Direction.BELOW && r < MIDPOINT_RANK);
	if (correct) {
		let newMult = (currentMultE18 * FACTOR_E18) / ONE;
		if (newMult > MAX_MULT_E18) newMult = MAX_MULT_E18;
		return { newCard, newMultE18: newMult, outcome: 'HIT' };
	}
	return { newCard, newMultE18: currentMultE18, outcome: 'BUST' };
}

function parseEvent(iface, receipt, name) {
	for (const l of receipt.logs) {
		try {
			const p = iface.parseLog(l);
			if (p?.name === name) return p;
		} catch {}
	}
	return null;
}

describe('HiLo Cross-Validation: real on-chain', () => {
	it(`places ${N_BETS.toLocaleString(
		'en-US'
	)} bets and per-round asserts contract == off-chain model`, async function () {
		this.timeout(60 * 60 * 1000);

		const ctx = await loadFixture(deployFixture);
		const { hilo, vrf, core, coreAddr, usdcAddr, player } = ctx;

		let totalStake = 0n;
		let totalPayout = 0n;
		let totalRounds = 0;
		let cashedOut = 0;
		let bustedOut = 0;
		const startTime = Date.now();

		for (let i = 0; i < N_BETS; i++) {
			const cashoutTarget = (i % 3) + 1; // K=1, 2, or 3
			const direction = Direction.ABOVE; // symmetric

			// Place bet — pulls stake, submits first guess
			const word0 = wordFromSeed(`b${i}-r0`);
			const tx = await hilo
				.connect(player)
				.placeBet(usdcAddr, BET_AMOUNT, ethers.ZeroAddress, direction, false);
			const receipt = await tx.wait();
			const placed = parseEvent(hilo.interface, receipt, 'BetPlaced');
			expect(placed, `BetPlaced not emitted at bet ${i}`).to.not.be.undefined;
			const betId = placed.args.betId;
			const guess = parseEvent(hilo.interface, receipt, 'GuessChosen');
			const firstReqId = guess.args.requestId;

			// Fulfill VRF1
			await vrf.fulfillRandomWords(coreAddr, firstReqId, [word0]);

			let predictedMult = ONE; // start at 1.0x
			let predictedCorrect = 0;
			let {
				newCard: c,
				newMultE18: m,
				outcome: o,
			} = applyRoundOffChain(predictedMult, direction, word0);
			predictedMult = m;
			if (o === 'HIT') predictedCorrect++;

			// Verify state matches prediction
			let state = await hilo.getBetState(betId);
			expect(Number(state.lastCard), `last card at bet ${i} r0`).to.equal(c);
			expect(state.currentMultiplierE18, `mult at bet ${i} r0`).to.equal(predictedMult);

			totalRounds++;

			// Loop: continue until BUST or cashout target reached
			let round = 1;
			let bust = o === 'BUST';
			while (!bust && predictedCorrect < cashoutTarget) {
				const word = wordFromSeed(`b${i}-r${round}`);
				const r2 = applyRoundOffChain(predictedMult, direction, word);

				// Submit guess
				const gtx = await hilo.connect(player).makeAction(betId, direction);
				const greceipt = await gtx.wait();
				const guessed = parseEvent(hilo.interface, greceipt, 'GuessChosen');
				const reqId = guessed.args.requestId;
				await vrf.fulfillRandomWords(coreAddr, reqId, [word]);

				predictedMult = r2.newMultE18;
				if (r2.outcome === 'HIT') predictedCorrect++;
				bust = r2.outcome === 'BUST';

				state = await hilo.getBetState(betId);
				expect(Number(state.lastCard), `last card at bet ${i} r${round}`).to.equal(r2.newCard);
				expect(state.currentMultiplierE18, `mult at bet ${i} r${round}`).to.equal(predictedMult);

				totalRounds++;
				round++;
				// Safety: cap max rounds per bet
				if (round > 50) throw new Error(`bet ${i} stuck at round ${round}`);
			}

			let expectedPayout = 0n;
			if (bust) {
				bustedOut++;
				const base = await hilo.getBetBase(betId);
				expect(Number(base.status), `expected RESOLVED on bust at bet ${i}`).to.equal(
					BetStatus.RESOLVED
				);
				expect(Number(base.outcome), `expected WRONG_GUESS on bust at bet ${i}`).to.equal(
					Outcome.WRONG_GUESS
				);
				expect(base.payout, `payout=0 on bust at bet ${i}`).to.equal(0n);
				expectedPayout = 0n;
			} else {
				// Cashout
				cashedOut++;
				expectedPayout = (BET_AMOUNT * predictedMult) / ONE;
				await hilo.connect(player).makeAction(betId, 2);
				const base = await hilo.getBetBase(betId);
				expect(Number(base.status)).to.equal(BetStatus.RESOLVED);
				expect(Number(base.outcome)).to.equal(Outcome.CASHED_OUT);
				expect(base.payout, `cashout payout at bet ${i}`).to.equal(expectedPayout);
			}

			totalStake += BET_AMOUNT;
			totalPayout += expectedPayout;

			if ((i + 1) % PROGRESS_EVERY === 0) {
				const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
				console.log(
					`  ${(i + 1)
						.toString()
						.padStart(
							5
						)}/${N_BETS}   ${elapsed}s   ${totalRounds} rounds   bust=${bustedOut}, cashout=${cashedOut}`
				);
			}
		}

		const rtp = Number((totalPayout * 1_000_000n) / totalStake) / 1_000_000;
		console.log('');
		console.log(`========== AGGREGATE RESULTS (${N_BETS} bets, ${totalRounds} rounds) ==========`);
		console.log(`Cashed out:           ${cashedOut} (${((cashedOut / N_BETS) * 100).toFixed(2)}%)`);
		console.log(`Busted:               ${bustedOut} (${((bustedOut / N_BETS) * 100).toFixed(2)}%)`);
		console.log(`Realized RTP:         ${(rtp * 100).toFixed(4)}%`);
		console.log(`(Analytic baseline for mixed K=1/2/3: ~(0.9783 + 0.9572 + 0.9365)/3 ≈ 95.73%)`);
		console.log(`Per-bet/per-round invariants all matched.`);
	});
});
