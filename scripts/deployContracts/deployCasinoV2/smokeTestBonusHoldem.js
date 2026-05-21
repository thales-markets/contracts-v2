/**
 * Real-VRF smoke test for OvertimeBonusHoldem on optimisticSepolia.
 *
 * Plays N full hands (default 10) end-to-end through real Chainlink VRF:
 *   place → wait VRF1 → playPreFlop → wait VRF2 → checkFlop → wait VRF3 →
 *   checkTurn → wait VRF4 → checkRiver → wait VRF5 → verify RESOLVED.
 *
 * Each hand takes ~3-5 minutes wall-clock (5 VRF callbacks). 10 hands ≈ 30-50 min.
 *
 * Half the hands are placed with a bonus side bet so we exercise both legs of settlement.
 *
 * Run: `npx hardhat run scripts/deployContracts/deployCasinoV2/smokeTestBonusHoldem.js \
 *        --network optimisticSepolia`
 *
 * Override via env: `N_HANDS=3 ...` for shorter runs.
 */

const { ethers } = require('hardhat');
const { getTargetAddress } = require('../../helpers');

const N_HANDS = Number(process.env.N_HANDS || 10);
const ANTE = 3n * 1_000_000n; // 3 USDC
const BONUS = 3n * 1_000_000n;
const POLL_INTERVAL_MS = 8_000;
const VRF_TIMEOUT_MS = 5 * 60 * 1000; // 5 min per stage

const BetStatus = {
	0: 'NONE',
	1: 'AWAITING_HOLE',
	2: 'PRE_FLOP_TURN',
	3: 'AWAITING_FLOP',
	4: 'FLOP_TURN',
	5: 'AWAITING_TURN',
	6: 'TURN_TURN',
	7: 'AWAITING_RIVER',
	8: 'RIVER_TURN',
	9: 'AWAITING_RESOLVE',
	10: 'RESOLVED',
	11: 'CANCELLED',
};

const Outcome = { 0: 'NONE', 1: 'FOLDED', 2: 'PLAYER_WIN', 3: 'DEALER_WIN', 4: 'TIE' };

function fmtCard(c) {
	const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
	const suits = ['♣', '♦', '♥', '♠'];
	const r = c % 13;
	const s = Math.floor(c / 13);
	return ranks[r] + suits[s];
}

async function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function waitForStatus(bh, betId, expected, label) {
	const start = Date.now();
	let last = -1;
	while (Date.now() - start < VRF_TIMEOUT_MS) {
		const base = await bh.getBetBase(betId);
		const s = Number(base.status);
		if (s !== last) {
			process.stdout.write(`    [${label}] status=${BetStatus[s]}\r`);
			last = s;
		}
		if (s === expected) {
			process.stdout.write(`    [${label}] status=${BetStatus[s]}                  \n`);
			return base;
		}
		await sleep(POLL_INTERVAL_MS);
	}
	throw new Error(`Timeout waiting for ${BetStatus[expected]} at ${label} (bet ${betId})`);
}

async function parseBetId(bh, receipt) {
	for (const log of receipt.logs) {
		try {
			const p = bh.interface.parseLog(log);
			if (p?.name === 'BetPlaced') return p.args.betId;
		} catch {}
	}
	throw new Error('BetPlaced event not found');
}

async function playOneHand(ctx, idx) {
	const { bh, usdc, signer } = ctx;
	const withBonus = idx % 2 === 0;
	const ante = ANTE;
	const bonus = withBonus ? BONUS : 0n;

	const balBefore = await usdc.balanceOf(signer.address);
	console.log(
		`\n=== Hand ${idx + 1}/${N_HANDS}: ante=${Number(ante) / 1e6} USDC, bonus=${
			Number(bonus) / 1e6
		} USDC, balBefore=${Number(balBefore) / 1e6} USDC ===`
	);

	const tx = await bh.placeBet(await usdc.getAddress(), ante, bonus, ethers.ZeroAddress);
	const receipt = await tx.wait();
	const betId = await parseBetId(bh, receipt);
	console.log(`  placeBet tx ${tx.hash}  betId=${betId}`);

	await waitForStatus(bh, betId, 2 /* PRE_FLOP_TURN */, 'VRF1 hole');
	const full1 = await bh.getFullRecord(betId);
	console.log(
		`    hole: ${fmtCard(Number(full1.playerHole[0]))} ${fmtCard(Number(full1.playerHole[1]))}`
	);

	const tx2 = await bh.playPreFlop(betId);
	await tx2.wait();
	console.log(`  playPreFlop tx ${tx2.hash}`);
	await waitForStatus(bh, betId, 4 /* FLOP_TURN */, 'VRF2 flop');
	const full2 = await bh.getFullRecord(betId);
	console.log(
		`    flop: ${fmtCard(Number(full2.community[0]))} ${fmtCard(
			Number(full2.community[1])
		)} ${fmtCard(Number(full2.community[2]))}`
	);

	const tx3 = await bh.checkFlop(betId);
	await tx3.wait();
	console.log(`  checkFlop tx ${tx3.hash}`);
	await waitForStatus(bh, betId, 6 /* TURN_TURN */, 'VRF3 turn');
	const full3 = await bh.getFullRecord(betId);
	console.log(`    turn: ${fmtCard(Number(full3.community[3]))}`);

	const tx4 = await bh.checkTurn(betId);
	await tx4.wait();
	console.log(`  checkTurn tx ${tx4.hash}`);
	await waitForStatus(bh, betId, 8 /* RIVER_TURN */, 'VRF4 river');
	const full4 = await bh.getFullRecord(betId);
	console.log(`    river: ${fmtCard(Number(full4.community[4]))}`);

	const tx5 = await bh.checkRiver(betId);
	await tx5.wait();
	console.log(`  checkRiver tx ${tx5.hash}`);
	const final = await waitForStatus(bh, betId, 10 /* RESOLVED */, 'VRF5 resolve');
	const fullFinal = await bh.getFullRecord(betId);
	console.log(
		`    dealer: ${fmtCard(Number(fullFinal.dealerHole[0]))} ${fmtCard(
			Number(fullFinal.dealerHole[1])
		)}`
	);
	console.log(`    outcome: ${Outcome[Number(final.outcome)]}`);
	console.log(
		`    payouts: ante=${Number(fullFinal.antePayout) / 1e6}, bonus=${
			Number(fullFinal.bonusPayout) / 1e6
		}, play=${Number(fullFinal.playPayout) / 1e6}, flop=${
			Number(fullFinal.flopPayout) / 1e6
		}, turn=${Number(fullFinal.turnPayout) / 1e6}, river=${Number(fullFinal.riverPayout) / 1e6}`
	);
	console.log(`    totalPayout: ${Number(fullFinal.totalPayout) / 1e6} USDC`);

	const balAfter = await usdc.balanceOf(signer.address);
	const net = Number(balAfter - balBefore) / 1e6;
	console.log(`    balAfter=${Number(balAfter) / 1e6} USDC  (net ${net >= 0 ? '+' : ''}${net})`);
	return { idx, outcome: Outcome[Number(final.outcome)], net };
}

async function main() {
	const [signer] = await ethers.getSigners();
	const network = (await ethers.provider.getNetwork()).name;
	if (network !== 'optimisticSepolia') {
		throw new Error(`expected optimisticSepolia, got ${network}`);
	}
	console.log('Signer :', signer.address);
	console.log('Network:', network);

	const bhAddr = getTargetAddress('OvertimeBonusHoldem', network);
	const usdcAddr =
		getTargetAddress('USDC', network) || getTargetAddress('DefaultCollateral', network);
	if (!bhAddr) throw new Error('OvertimeBonusHoldem missing in deployments.json');
	if (!usdcAddr) throw new Error('USDC / DefaultCollateral missing in deployments.json');

	const bh = await ethers.getContractAt('OvertimeBonusHoldem', bhAddr);
	const usdc = await ethers.getContractAt('IERC20', usdcAddr);

	const coreAddr = await bh.core();

	// Ensure approval is in place
	const allowance = await usdc.allowance(signer.address, coreAddr);
	const needed = ethers.MaxUint256 / 2n;
	if (allowance < needed) {
		const tx = await usdc.approve(coreAddr, ethers.MaxUint256);
		await tx.wait();
		console.log(`Approved core for USDC: ${tx.hash}`);
	}

	const balance = await usdc.balanceOf(signer.address);
	console.log(`USDC balance: ${Number(balance) / 1e6}`);
	if (balance < (ANTE + BONUS) * BigInt(N_HANDS)) {
		console.log(`!! Balance may be insufficient for ${N_HANDS} hands; proceeding anyway`);
	}

	const ctx = { bh, usdc, signer, coreAddr };
	const results = [];
	const startTime = Date.now();
	for (let i = 0; i < N_HANDS; i++) {
		try {
			const r = await playOneHand(ctx, i);
			results.push(r);
		} catch (e) {
			console.error(`Hand ${i + 1} FAILED:`, e.message);
			results.push({ idx: i, outcome: 'ERROR', net: 0, error: e.message });
		}
	}
	const elapsed = ((Date.now() - startTime) / 60_000).toFixed(1);

	console.log('\n========== SUMMARY ==========');
	console.log(`Hands: ${N_HANDS}    Elapsed: ${elapsed} min`);
	const outcomes = {};
	let totalNet = 0;
	for (const r of results) {
		outcomes[r.outcome] = (outcomes[r.outcome] || 0) + 1;
		totalNet += r.net;
	}
	for (const [o, c] of Object.entries(outcomes)) console.log(`  ${o}: ${c}`);
	console.log(`Total net P&L: ${totalNet >= 0 ? '+' : ''}${totalNet.toFixed(2)} USDC`);
	const errs = results.filter((r) => r.outcome === 'ERROR');
	if (errs.length > 0) {
		console.log(`\n!! ${errs.length} hand(s) errored — see above`);
		process.exit(1);
	}
	console.log('\nAll hands resolved successfully.');
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
