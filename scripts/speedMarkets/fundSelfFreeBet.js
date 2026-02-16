const { ethers } = require('hardhat');
const { getTargetAddress } = require('../helpers');

async function main() {
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	if (networkObj.chainId == 11155420) {
		networkObj.name = 'optimisticSepolia';
		network = 'optimisticSepolia';
	}

	let accounts = await ethers.getSigners();
	let owner = accounts[0];

	console.log('Owner is: ' + owner.address);
	console.log('Network:' + network);
	console.log('Network id:' + networkObj.chainId);

	// Get the deployed FreeBetsHolder contract
	const freeBetsHolderAddress = getTargetAddress('FreeBetsHolder', network);
	console.log('FreeBetsHolder address:', freeBetsHolderAddress);

	const freeBetsHolder = await ethers.getContractAt('FreeBetsHolder', freeBetsHolderAddress);

	// Get the default collateral address
	const defaultCollateralAddress = getTargetAddress('DefaultCollateral', network);
	console.log('Default collateral address:', defaultCollateralAddress);

	const collateral = await ethers.getContractAt('IERC20', defaultCollateralAddress);

	// Amount to fund (e.g., 10 USDC with 6 decimals)
	const fundAmount = ethers.parseUnits('10', 6);
	console.log('\nFunding amount:', ethers.formatUnits(fundAmount, 6), 'USDC');

	// Check current balances
	const ownerCollateralBalance = await collateral.balanceOf(owner.address);
	console.log('Owner collateral balance:', ethers.formatUnits(ownerCollateralBalance, 6), 'USDC');

	const currentFreeBetBalance = await freeBetsHolder.balancePerUserAndCollateral(
		owner.address,
		defaultCollateralAddress
	);
	console.log('Current free bet balance:', ethers.formatUnits(currentFreeBetBalance, 6), 'USDC');

	// Check if free bet is currently valid
	const freeBetInfo = await freeBetsHolder.isFreeBetValid(owner.address, defaultCollateralAddress);
	console.log('Free bet currently valid:', freeBetInfo.isValid);

	// Approve FreeBetsHolder to spend collateral
	console.log('\nApproving FreeBetsHolder to spend collateral...');
	const approveTx = await collateral.approve(freeBetsHolderAddress, fundAmount);
	await approveTx.wait();
	console.log('Approval confirmed');

	// Fund self with free bet
	console.log('\nFunding self with free bet...');
	const fundTx = await freeBetsHolder.fund(owner.address, defaultCollateralAddress, fundAmount);
	const receipt = await fundTx.wait();
	console.log('Fund transaction confirmed in block:', receipt.blockNumber);

	// Check for UserFunded event
	const fundedEvent = receipt.logs?.find((log) => {
		try {
			const parsed = freeBetsHolder.interface.parseLog(log);
			return parsed?.name === 'UserFunded';
		} catch {
			return false;
		}
	});

	if (fundedEvent) {
		const parsed = freeBetsHolder.interface.parseLog(fundedEvent);
		console.log('\nUserFunded event:');
		console.log('  User:', parsed.args.user);
		console.log('  Collateral:', parsed.args.collateral);
		console.log('  Amount:', ethers.formatUnits(parsed.args.amount, 6), 'USDC');
		console.log('  Funder:', parsed.args.funder);
	}

	// Check updated balances
	const newFreeBetBalance = await freeBetsHolder.balancePerUserAndCollateral(
		owner.address,
		defaultCollateralAddress
	);
	console.log('\nNew free bet balance:', ethers.formatUnits(newFreeBetBalance, 6), 'USDC');

	const newFreeBetInfo = await freeBetsHolder.isFreeBetValid(
		owner.address,
		defaultCollateralAddress
	);
	console.log('Free bet now valid:', newFreeBetInfo.isValid);
	if (newFreeBetInfo.isValid) {
		console.log('Time to expiration:', newFreeBetInfo.timeToExpiration.toString(), 'seconds');
	}

	console.log('\nScript completed successfully!');
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
