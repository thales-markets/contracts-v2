const { ethers } = require('hardhat');
const { getTargetAddress } = require('../../helpers');
async function main() {
	const net = (await ethers.provider.getNetwork()).name;
	const bj = await ethers.getContractAt('Blackjack', getTargetAddress('Blackjack', net));
	console.log(
		`${net}: cancelTimeout = ${await bj.cancelTimeout()}s, callbackGasLimit = ${await bj.callbackGasLimit()}`
	);
}
main()
	.catch((e) => {
		console.error(e);
		process.exit(1);
	})
	.then(() => process.exit(0));
