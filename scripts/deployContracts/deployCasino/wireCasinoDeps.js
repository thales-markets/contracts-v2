const { ethers } = require('hardhat');
const all = require('../../deployments.json');

/**
 * Wires the four casino handshakes, idempotent:
 *   1. Casino.setFreeBetsHolder(FreeBetsHolder)
 *   2. FreeBetsHolder.setWhitelistedCasino(casino, true)
 *   3. Casino.setReferrals(Referrals)
 *   4. Referrals.setWhitelistedAddress(casino, true)
 * Each step is skipped when already set or when we don't own the target.
 */
async function main() {
	const [signer] = await ethers.getSigners();
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;
	const addrs = all[network];
	if (!addrs) throw new Error(`No deployments for ${network}`);

	console.log(`Network: ${network} (chain ${networkObj.chainId})`);
	console.log(`Signer:  ${signer.address}\n`);

	const holderAddr = addrs.FreeBetsHolder;
	const referralsAddr = addrs.Referrals;
	console.log(`FreeBetsHolder: ${holderAddr}`);
	console.log(`Referrals:      ${referralsAddr}\n`);

	const holderAbi = [
		'function whitelistedCasino(address) view returns (bool)',
		'function setWhitelistedCasino(address,bool)',
		'function owner() view returns (address)',
	];
	const referralsAbi = [
		'function whitelistedAddresses(address) view returns (bool)',
		'function setWhitelistedAddress(address,bool)',
		'function owner() view returns (address)',
	];
	const holder = holderAddr ? new ethers.Contract(holderAddr, holderAbi, signer) : null;
	const referrals = referralsAddr ? new ethers.Contract(referralsAddr, referralsAbi, signer) : null;

	const holderOwner = holder ? await holder.owner() : null;
	const referralsOwner = referrals ? await referrals.owner() : null;
	const amHolderOwner = holderOwner && holderOwner.toLowerCase() === signer.address.toLowerCase();
	const amReferralsOwner =
		referralsOwner && referralsOwner.toLowerCase() === signer.address.toLowerCase();
	console.log(`Am I FreeBetsHolder.owner()? ${amHolderOwner}  (owner=${holderOwner})`);
	console.log(`Am I Referrals.owner()?      ${amReferralsOwner}  (owner=${referralsOwner})\n`);

	const casinos = ['Dice', 'Roulette', 'Blackjack', 'Baccarat', 'Slots'];
	for (const name of casinos) {
		const a = addrs[name];
		if (!a) {
			console.log(`${name.padEnd(10)} (not deployed) — skip`);
			continue;
		}
		console.log(`--- ${name} (${a}) ---`);
		const c = await ethers.getContractAt(name, a);
		const ownerOnChain = await c.owner();
		const amOwner = ownerOnChain.toLowerCase() === signer.address.toLowerCase();

		// 1. casino.setFreeBetsHolder
		if (holder) {
			const cur = await c.freeBetsHolder();
			if (cur.toLowerCase() === holderAddr.toLowerCase()) {
				console.log(`  1. setFreeBetsHolder: already wired`);
			} else if (!amOwner) {
				console.log(`  1. setFreeBetsHolder: not casino owner (${ownerOnChain}) — skip`);
			} else {
				const tx = await c.setFreeBetsHolder(holderAddr);
				const r = await tx.wait();
				console.log(`  1. setFreeBetsHolder: tx ${r.hash}`);
			}

			// 2. holder.setWhitelistedCasino
			try {
				const wl = await holder.whitelistedCasino(a);
				if (wl) {
					console.log(`  2. holder.setWhitelistedCasino: already whitelisted`);
				} else if (!amHolderOwner) {
					console.log(`  2. holder.setWhitelistedCasino: not holder owner — skip`);
				} else {
					const tx = await holder.setWhitelistedCasino(a, true);
					const r = await tx.wait();
					console.log(`  2. holder.setWhitelistedCasino: tx ${r.hash}`);
				}
			} catch (e) {
				console.log(
					`  2. holder.setWhitelistedCasino: unavailable on this holder (likely older impl) — skip`
				);
			}
		}

		// 3. casino.setReferrals
		if (referrals) {
			const cur = await c.referrals();
			if (cur.toLowerCase() === referralsAddr.toLowerCase()) {
				console.log(`  3. setReferrals: already wired`);
			} else if (!amOwner) {
				console.log(`  3. setReferrals: not casino owner — skip`);
			} else {
				const tx = await c.setReferrals(referralsAddr);
				const r = await tx.wait();
				console.log(`  3. setReferrals: tx ${r.hash}`);
			}

			// 4. referrals.setWhitelistedAddress
			try {
				const wl = await referrals.whitelistedAddresses(a);
				if (wl) {
					console.log(`  4. referrals.setWhitelistedAddress: already whitelisted`);
				} else if (!amReferralsOwner) {
					console.log(`  4. referrals.setWhitelistedAddress: not referrals owner — skip`);
				} else {
					const tx = await referrals.setWhitelistedAddress(a, true);
					const r = await tx.wait();
					console.log(`  4. referrals.setWhitelistedAddress: tx ${r.hash}`);
				}
			} catch (e) {
				console.log(`  4. referrals.setWhitelistedAddress: unavailable / reverted — skip`);
			}
		}
	}

	console.log('\n=== Final state ===');
	for (const name of casinos) {
		const a = addrs[name];
		if (!a) continue;
		const c = await ethers.getContractAt(name, a);
		const fbh = holder ? await c.freeBetsHolder() : '-';
		let holderWl = '?';
		try {
			holderWl = holder ? String(await holder.whitelistedCasino(a)) : '-';
		} catch {
			holderWl = 'n/a';
		}
		const ref = referrals ? await c.referrals() : '-';
		let refWl = '?';
		try {
			refWl = referrals ? String(await referrals.whitelistedAddresses(a)) : '-';
		} catch {
			refWl = 'n/a';
		}
		console.log(
			`${name.padEnd(10)} fbh=${
				fbh !== '-' ? (fbh.toLowerCase() === holderAddr?.toLowerCase() ? 'ok' : 'NO') : '-'
			}  holderWL=${holderWl}  ref=${
				ref !== '-' ? (ref.toLowerCase() === referralsAddr?.toLowerCase() ? 'ok' : 'NO') : '-'
			}  refWL=${refWl}`
		);
	}
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
