const { ethers } = require('hardhat');
const { getTargetAddress } = require('../../helpers');

async function main() {
	const network = (await ethers.provider.getNetwork()).name;
	const proxy = getTargetAddress('Blackjack', network);
	const slot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
	const raw = await ethers.provider.getStorage(proxy, slot);
	const impl = '0x' + raw.slice(26);
	console.log(`${network} proxy=${proxy} impl=${ethers.getAddress(impl)}`);
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
