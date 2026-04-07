const { ethers } = require('hardhat');
const { getTargetAddress } = require('../../helpers');

async function main() {
	const owner = (await ethers.getSigners())[0];
	const network = (await ethers.provider.getNetwork()).name;

	const usdcAddress = getTargetAddress('DefaultCollateral', network);
	const wethAddress = getTargetAddress('WETH', network);
	const overAddress = getTargetAddress('OVER', network);

	const usdc = await ethers.getContractAt('IERC20', usdcAddress);
	const weth = await ethers.getContractAt('IERC20', wethAddress);
	const over = await ethers.getContractAt('IERC20', overAddress);

	const ethBal = await ethers.provider.getBalance(owner.address);

	console.log('Wallet:', owner.address);
	console.log('ETH:', ethers.formatEther(ethBal));
	console.log('USDC:', ethers.formatUnits(await usdc.balanceOf(owner.address), 6));
	console.log('WETH:', ethers.formatEther(await weth.balanceOf(owner.address)));
	console.log('OVER:', ethers.formatEther(await over.balanceOf(owner.address)));
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
