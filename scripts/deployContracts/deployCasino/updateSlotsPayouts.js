const { ethers } = require('hardhat');
const { getTargetAddress, delay } = require('../../helpers');

// ============================================================
// Reconfigure an already-deployed Slots contract to the current
// production game math. Requires the new Slots implementation
// (with pairPayout support) — old implementations will revert on
// setPairPayout.
//
// If you need to migrate from the OLD (triple-only) contract,
// run scripts/deployContracts/deployCasino/redeploySlots.js instead
// — it drains the old proxy, deploys a fresh one, and re-funds it.
// ============================================================
// 5 symbols with balanced weights and pair + triple payouts.
// Weights: [34, 26, 18, 13, 9]   (sum 100)
// Pair:    [0.5, 0.75, 1, 1.25, 1.75]   (raw multipliers)
// Triple:  [2, 4, 10, 20, 38]           (raw multipliers)
// => Hit rate ~41.56% (1 in 2.41), RTP ~95.05%
//    Min win 1.49x stake, max win 38.24x stake, every triple > every pair.
// ============================================================

const NEW_SYMBOL_COUNT = 5;
const NEW_SYMBOL_WEIGHTS = [34, 26, 18, 13, 9];
const NEW_PAIR_PAYOUTS = [
	ethers.parseEther('0.5'),
	ethers.parseEther('0.75'),
	ethers.parseEther('1'),
	ethers.parseEther('1.25'),
	ethers.parseEther('1.75'),
];
const NEW_TRIPLE_PAYOUTS = [
	ethers.parseEther('2'),
	ethers.parseEther('4'),
	ethers.parseEther('10'),
	ethers.parseEther('20'),
	ethers.parseEther('38'),
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

	// Sanity check: if the contract doesn't expose pairPayout this will throw and abort.
	try {
		await slots.pairPayout(0);
	} catch (e) {
		console.error(
			'\nERROR: this Slots contract does not support pairPayout. ' +
				'Run redeploySlots.js to migrate to the new implementation.'
		);
		process.exit(1);
	}

	console.log('\nCurrent state:');
	const currentSymbolCount = Number(await slots.symbolCount());
	for (let i = 0; i < Math.max(currentSymbolCount, 5); i++) {
		try {
			const pair = await slots.pairPayout(i);
			const triple = await slots.triplePayout(i);
			console.log(
				`  symbol ${i}: pair=${ethers.formatEther(pair)}x, triple=${ethers.formatEther(triple)}x`
			);
		} catch {
			console.log(`  symbol ${i}: (out of range)`);
		}
	}

	// ============================================================
	// Pause first so nobody can bet in an intermediate state
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
	// If symbolCount is shrinking, zero out orphan payouts BEFORE calling setSymbols
	// (after setSymbols, symbol >= symbolCount reverts on setPairPayout/setTriplePayout)
	// ============================================================
	if (currentSymbolCount > NEW_SYMBOL_COUNT) {
		console.log(
			`\nZeroing orphan payouts for symbols ${NEW_SYMBOL_COUNT}..${currentSymbolCount - 1}`
		);
		for (let i = NEW_SYMBOL_COUNT; i < currentSymbolCount; i++) {
			const pair = await slots.pairPayout(i);
			if (pair !== 0n) {
				await sendTx(slots, owner, 'setPairPayout', i, 0);
				console.log(`  pair[${i}] zeroed`);
			}
			const triple = await slots.triplePayout(i);
			if (triple !== 0n) {
				await sendTx(slots, owner, 'setTriplePayout', i, 0);
				console.log(`  triple[${i}] zeroed`);
			}
		}
	}

	// ============================================================
	// Update symbolCount and weights
	// ============================================================
	if (currentSymbolCount !== NEW_SYMBOL_COUNT || !(await sameWeights(slots, NEW_SYMBOL_WEIGHTS))) {
		console.log(
			`\nSetting symbols to ${NEW_SYMBOL_COUNT} with weights [${NEW_SYMBOL_WEIGHTS.join(', ')}]...`
		);
		await sendTx(slots, owner, 'setSymbols', NEW_SYMBOL_COUNT, NEW_SYMBOL_WEIGHTS);
		console.log('Symbols updated');
	} else {
		console.log('\nSymbols already match, skipping');
	}

	// ============================================================
	// Update pair payouts
	// ============================================================
	console.log('\nUpdating pair payouts...');
	for (let i = 0; i < NEW_PAIR_PAYOUTS.length; i++) {
		const current = await slots.pairPayout(i);
		if (current === NEW_PAIR_PAYOUTS[i]) {
			console.log(`  pair[${i}]: already ${ethers.formatEther(current)}x, skip`);
			continue;
		}
		await sendTx(slots, owner, 'setPairPayout', i, NEW_PAIR_PAYOUTS[i]);
		console.log(
			`  pair[${i}]: ${ethers.formatEther(NEW_PAIR_PAYOUTS[i])}x set (was ${ethers.formatEther(
				current
			)}x)`
		);
	}

	// ============================================================
	// Update triple payouts
	// ============================================================
	console.log('\nUpdating triple payouts...');
	for (let i = 0; i < NEW_TRIPLE_PAYOUTS.length; i++) {
		const current = await slots.triplePayout(i);
		if (current === NEW_TRIPLE_PAYOUTS[i]) {
			console.log(`  triple[${i}]: already ${ethers.formatEther(current)}x, skip`);
			continue;
		}
		await sendTx(slots, owner, 'setTriplePayout', i, NEW_TRIPLE_PAYOUTS[i]);
		console.log(
			`  triple[${i}]: ${ethers.formatEther(NEW_TRIPLE_PAYOUTS[i])}x set (was ${ethers.formatEther(
				current
			)}x)`
		);
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
	// Verify + compute analytic RTP
	// ============================================================
	console.log('\n==================== VERIFICATION ====================');
	const finalSymbolCount = Number(await slots.symbolCount());
	const finalWeights = [];
	for (let i = 0; i < finalSymbolCount; i++) {
		finalWeights.push(Number(await slots.symbolWeights(i)));
	}
	console.log(`Final symbolCount: ${finalSymbolCount}`);
	console.log(`Final weights:     [${finalWeights.join(', ')}]`);

	const totalWeight = finalWeights.reduce((a, b) => a + b, 0);
	const p = finalWeights.map((w) => w / totalWeight);
	const houseEdgeNum = Number(ethers.formatEther(await slots.houseEdge()));

	let hitRate = 0;
	let rtp = 0;
	console.log('Per-symbol payouts:');
	for (let i = 0; i < finalSymbolCount; i++) {
		const pair = Number(ethers.formatEther(await slots.pairPayout(i)));
		const triple = Number(ethers.formatEther(await slots.triplePayout(i)));
		const pairProb = 2 * p[i] * p[i] * (1 - p[i]); // adjacent pair excluding triples
		const tripleProb = p[i] ** 3;
		hitRate += pairProb + tripleProb;
		rtp += pairProb * (1 + (1 - houseEdgeNum) * pair);
		rtp += tripleProb * (1 + (1 - houseEdgeNum) * triple);
		console.log(
			`  symbol ${i} (w=${finalWeights[i]}): pair=${pair}x (${(pairProb * 100).toFixed(3)}%), ` +
				`triple=${triple}x (${(tripleProb * 100).toFixed(4)}%)`
		);
	}
	console.log(`Hit rate:   ${(hitRate * 100).toFixed(2)}% (1 in ${(1 / hitRate).toFixed(2)})`);
	console.log(`RTP:        ${(rtp * 100).toFixed(2)}%`);
	console.log(`House edge: ${((1 - rtp) * 100).toFixed(2)}%`);
	console.log('======================================================');

	console.log('\nDone.');
}

async function sameWeights(slots, expected) {
	const count = Number(await slots.symbolCount());
	if (count !== expected.length) return false;
	for (let i = 0; i < count; i++) {
		if (Number(await slots.symbolWeights(i)) !== expected[i]) return false;
	}
	return true;
}

main()
	.then(() => process.exit(0))
	.catch(async (error) => {
		console.error('\nERROR:', error.message || error);
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
