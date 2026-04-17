const { ethers } = require('hardhat');
const all = require('../../deployments.json');

async function main() {
	const [owner] = await ethers.getSigners();
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;
	const addrs = all[network];
	if (!addrs) throw new Error(`No deployments for ${network}`);

	const holderAddr = addrs.FreeBetsHolder;
	if (!holderAddr) throw new Error('FreeBetsHolder not set');

	console.log(`Network: ${network} (chain ${networkObj.chainId})`);
	console.log(`Signer:  ${owner.address}`);
	console.log(`FreeBetsHolder target: ${holderAddr}\n`);

	const casinos = ['Dice', 'Roulette', 'Blackjack', 'Baccarat', 'Slots'];
	for (const name of casinos) {
		const a = addrs[name];
		if (!a) {
			console.log(`${name.padEnd(10)} (not deployed) — skip`);
			continue;
		}
		const c = await ethers.getContractAt(name, a);
		const current = await c.freeBetsHolder();
		if (current.toLowerCase() === holderAddr.toLowerCase()) {
			console.log(`${name.padEnd(10)} already wired — skip`);
			continue;
		}
		const ownerOnChain = await c.owner();
		if (ownerOnChain.toLowerCase() !== owner.address.toLowerCase()) {
			console.log(`${name.padEnd(10)} not owner (owner=${ownerOnChain}) — skip`);
			continue;
		}
		process.stdout.write(`${name.padEnd(10)} setFreeBetsHolder(${holderAddr}) ... `);
		const tx = await c.setFreeBetsHolder(holderAddr);
		const rcpt = await tx.wait();
		console.log(`tx ${rcpt.hash}`);
	}

	console.log('\n--- Verify ---');
	for (const name of casinos) {
		const a = addrs[name];
		if (!a) continue;
		const c = await ethers.getContractAt(name, a);
		const fbh = await c.freeBetsHolder();
		const ok = fbh.toLowerCase() === holderAddr.toLowerCase();
		console.log(`${name.padEnd(10)} freeBetsHolder=${fbh}  wired=${ok}`);
	}
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
