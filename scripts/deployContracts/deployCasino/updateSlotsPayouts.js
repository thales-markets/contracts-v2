const { ethers } = require('hardhat');
const { getTargetAddress, delay } = require('../../helpers');

// ============================================================
// Industry-standard skewed weights for proper slot feel
// ============================================================
// 3 symbols with weights [62, 28, 10] (total 100)
// Payouts: [2, 6, 43]
// Hit rate: 0.62³ + 0.28³ + 0.10³ = 26.1% (1 in 3.8 spins)
// RTP ≈ 0.238 × 2.96 + 0.022 × 6.88 + 0.001 × 43.14 = 90.0%
// All wins are ≥ 2.96x stake (no "small losing wins")
// Longest expected loss streak in 100 spins: ~15 (vs 133 before)
// ============================================================

const NEW_SYMBOL_COUNT = 3;
const NEW_SYMBOL_WEIGHTS = [62, 28, 10];
const NEW_TRIPLE_PAYOUTS = [
	ethers.parseEther('2'), // symbol 0 (common): 2x   → total return 2.96x
	ethers.parseEther('6'), // symbol 1 (mid):    6x   → total return 6.88x
	ethers.parseEther('43'), // symbol 2 (jackpot): 43x → total return 43.14x
];

let slotsRef; // For error handler unpause

async function sendTx(slots, signer, method, ...args) {
	const nonce = await signer.provider.getTransactionCount(signer.address, 'pending');
	const tx = await slots[method](...args, { nonce });
	await tx.wait(1);
	await delay(3000);
	return tx;
}

async function main() {
	const owner = (await ethers.getSigners())[0];
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;

	const slotsAddress = getTargetAddress('Slots', network);
	const slots = await ethers.getContractAt('Slots', slotsAddress);
	slotsRef = slots;

	console.log('Owner:', owner.address);
	console.log('Network:', network);
	console.log('Slots:', slotsAddress);
	console.log('houseEdge:', ethers.formatEther(await slots.houseEdge()));
	console.log('symbolCount (before):', (await slots.symbolCount()).toString());

	console.log('\nCurrent triple payouts (all 5 slots):');
	for (let i = 0; i < 5; i++) {
		try {
			const current = await slots.triplePayout(i);
			console.log(`  symbol ${i}: ${ethers.formatEther(current)}x`);
		} catch {
			console.log(`  symbol ${i}: (out of range)`);
		}
	}

	// ============================================================
	// Pause first so the contract cannot be bet on in any intermediate state
	// ============================================================
	const wasPaused = await slots.paused();
	if (!wasPaused) {
		console.log('\nPausing contract...');
		await sendTx(slots, owner, 'setPausedByRole', true);
		console.log('Paused');
	} else {
		console.log('\nContract already paused, skipping pause step');
	}

	// ============================================================
	// Zero out orphan triple payouts for symbols 3 and 4
	// (must be done BEFORE setSymbols(3, ...) since after that, symbol >= symbolCount will revert)
	// ============================================================
	console.log('\nZeroing orphan triple payouts (symbols 3, 4)...');
	for (const i of [3, 4]) {
		const current = await slots.triplePayout(i);
		if (current !== 0n) {
			await sendTx(slots, owner, 'setTriplePayout', i, 0);
			console.log(`  symbol ${i}: zeroed (was ${ethers.formatEther(current)}x)`);
		} else {
			console.log(`  symbol ${i}: already 0`);
		}
	}

	// ============================================================
	// Update triple payouts for symbols 0, 1, 2
	// (still within current symbolCount=5, so safe to call)
	// ============================================================
	console.log('\nUpdating active triple payouts...');
	for (let i = 0; i < NEW_TRIPLE_PAYOUTS.length; i++) {
		const newValue = NEW_TRIPLE_PAYOUTS[i];
		const current = await slots.triplePayout(i);
		if (current === newValue) {
			console.log(`  symbol ${i}: already ${ethers.formatEther(newValue)}x, skipping`);
			continue;
		}
		await sendTx(slots, owner, 'setTriplePayout', i, newValue);
		console.log(
			`  symbol ${i}: ${ethers.formatEther(newValue)}x set (was ${ethers.formatEther(current)}x)`
		);
	}

	// ============================================================
	// Reduce symbol count and set new weights
	// ============================================================
	const currentSymbolCount = Number(await slots.symbolCount());
	if (currentSymbolCount !== NEW_SYMBOL_COUNT) {
		console.log(
			`\nSetting symbols to ${NEW_SYMBOL_COUNT} with weights [${NEW_SYMBOL_WEIGHTS.join(', ')}]...`
		);
		await sendTx(slots, owner, 'setSymbols', NEW_SYMBOL_COUNT, NEW_SYMBOL_WEIGHTS);
		console.log('Symbols updated');
	} else {
		console.log(`\nsymbolCount already ${NEW_SYMBOL_COUNT}, skipping`);
	}

	// ============================================================
	// Unpause
	// ============================================================
	if (!wasPaused) {
		console.log('\nUnpausing contract...');
		await sendTx(slots, owner, 'setPausedByRole', false);
		console.log('Unpaused');
	}

	// ============================================================
	// Verify final state + compute RTP
	// ============================================================
	console.log('\n==================== VERIFICATION ====================');
	const finalSymbolCount = await slots.symbolCount();
	console.log(`Final symbolCount: ${finalSymbolCount}`);
	const finalWeights = [];
	for (let i = 0; i < Number(finalSymbolCount); i++) {
		finalWeights.push(Number(await slots.symbolWeights(i)));
	}
	console.log(`Final weights: [${finalWeights.join(', ')}]`);

	const finalPayouts = [];
	for (let i = 0; i < Number(finalSymbolCount); i++) {
		finalPayouts.push(Number(ethers.formatEther(await slots.triplePayout(i))));
	}
	console.log(`Final payouts: [${finalPayouts.join(', ')}]`);

	const totalWeight = finalWeights.reduce((a, b) => a + b, 0);
	const houseEdgeNum = Number(ethers.formatEther(await slots.houseEdge()));
	let hitRate = 0;
	let rtp = 0;
	for (let i = 0; i < finalWeights.length; i++) {
		const p = Math.pow(finalWeights[i] / totalWeight, 3);
		hitRate += p;
		rtp += p * (1 + (1 - houseEdgeNum) * finalPayouts[i]);
	}

	console.log(
		`Hit rate:         ${(hitRate * 100).toFixed(2)}% (1 in ${(1 / hitRate).toFixed(1)} spins)`
	);
	console.log(`House edge param: ${(houseEdgeNum * 100).toFixed(2)}%`);
	console.log(`RTP:              ${(rtp * 100).toFixed(2)}%`);
	console.log(`Effective edge:   ${((1 - rtp) * 100).toFixed(2)}%`);
	console.log('Total returns per symbol:');
	for (let i = 0; i < finalWeights.length; i++) {
		const totalReturn = 1 + (1 - houseEdgeNum) * finalPayouts[i];
		const probPercent = (Math.pow(finalWeights[i] / totalWeight, 3) * 100).toFixed(2);
		console.log(`  symbol ${i}: ${totalReturn.toFixed(2)}x total (hits ${probPercent}% of spins)`);
	}
	console.log('======================================================');

	console.log('\nDone.');
}

main()
	.then(() => process.exit(0))
	.catch(async (error) => {
		console.error('\nERROR:', error.message || error);
		// Try to unpause if we failed mid-update
		if (slotsRef) {
			try {
				const stillPaused = await slotsRef.paused();
				if (stillPaused) {
					console.log('\nAttempting to unpause after error...');
					const tx = await slotsRef.setPausedByRole(false);
					await tx.wait();
					console.log('Unpaused');
				}
			} catch (e) {
				console.error('Failed to unpause:', e.message || e);
			}
		}
		process.exit(1);
	});
