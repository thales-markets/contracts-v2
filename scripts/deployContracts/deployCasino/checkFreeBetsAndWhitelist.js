const { ethers } = require('hardhat');
const { getImplementationAddress } = require('@openzeppelin/upgrades-core');
const all = require('../../deployments.json');

async function main() {
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;
	const addrs = all[network];
	if (!addrs) throw new Error(`No deployments for ${network}`);

	console.log(`\n=== Network: ${network} (chain ${networkObj.chainId}) ===`);

	console.log('\n--- FreeBetsHolder ---');
	console.log('Proxy:                         ', addrs.FreeBetsHolder);
	console.log('Expected impl (deployments):   ', addrs.FreeBetsHolderImplementation);
	const liveImpl = await getImplementationAddress(ethers.provider, addrs.FreeBetsHolder);
	console.log('Live impl on-chain:            ', liveImpl);
	const implMatches = liveImpl.toLowerCase() === addrs.FreeBetsHolderImplementation.toLowerCase();
	console.log('Impl matches deployments.json: ', implMatches);

	const holder = await ethers.getContractAt('FreeBetsHolder', addrs.FreeBetsHolder);

	console.log('\n--- Casino whitelist on FreeBetsHolder ---');
	const casinos = ['Dice', 'Roulette', 'Blackjack', 'Baccarat', 'Slots'];
	for (const name of casinos) {
		const a = addrs[name];
		if (!a) {
			console.log(`${name.padEnd(10)} (not deployed)`);
			continue;
		}
		const wl = await holder.whitelistedCasino(a);
		console.log(`${name.padEnd(10)} ${a}  whitelisted=${wl}`);
	}

	console.log('\n--- Casino.freeBetsHolder() wiring ---');
	for (const name of casinos) {
		const a = addrs[name];
		if (!a) continue;
		try {
			const c = await ethers.getContractAt(name, a);
			const fbh = await c.freeBetsHolder();
			const match = fbh.toLowerCase() === addrs.FreeBetsHolder.toLowerCase();
			console.log(`${name.padEnd(10)} freeBetsHolder=${fbh}  wired=${match}`);
		} catch (e) {
			console.log(`${name.padEnd(10)} error: ${(e.message || e).slice(0, 80)}`);
		}
	}
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
