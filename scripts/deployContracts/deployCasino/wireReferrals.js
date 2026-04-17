const { ethers } = require('hardhat');
const all = require('../../deployments.json');

async function main() {
	const [owner] = await ethers.getSigners();
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;
	const addrs = all[network];
	if (!addrs) throw new Error(`No deployments for ${network}`);

	const referralsAddr = addrs.Referrals;
	if (!referralsAddr) throw new Error('Referrals not set');

	console.log(`Network: ${network} (chain ${networkObj.chainId})`);
	console.log(`Signer:  ${owner.address}`);
	console.log(`Referrals target: ${referralsAddr}\n`);

	const casinos = ['Dice', 'Roulette', 'Blackjack', 'Baccarat', 'Slots'];
	for (const name of casinos) {
		const a = addrs[name];
		if (!a) {
			console.log(`${name.padEnd(10)} (not deployed) — skip`);
			continue;
		}
		const c = await ethers.getContractAt(name, a);
		const current = await c.referrals();
		if (current.toLowerCase() === referralsAddr.toLowerCase()) {
			console.log(`${name.padEnd(10)} already wired — skip`);
			continue;
		}
		const ownerOnChain = await c.owner();
		if (ownerOnChain.toLowerCase() !== owner.address.toLowerCase()) {
			console.log(`${name.padEnd(10)} not owner (owner=${ownerOnChain}) — skip`);
			continue;
		}
		process.stdout.write(`${name.padEnd(10)} setReferrals(${referralsAddr}) ... `);
		const tx = await c.setReferrals(referralsAddr);
		const rcpt = await tx.wait();
		console.log(`tx ${rcpt.hash}`);
	}

	console.log('\n--- Verify ---');
	for (const name of casinos) {
		const a = addrs[name];
		if (!a) continue;
		const c = await ethers.getContractAt(name, a);
		const ref = await c.referrals();
		const ok = ref.toLowerCase() === referralsAddr.toLowerCase();
		console.log(`${name.padEnd(10)} referrals=${ref}  wired=${ok}`);
	}
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
