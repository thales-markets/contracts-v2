const fs = require('fs');
const { ethers } = require('hardhat');
const { verifyProof } = require('./generateMerkleTree');

/**
 * Load merkle proofs from file
 * @param {string} proofsFilePath - Path to the merkle proofs JSON file
 * @returns {Object} Proofs data
 */
function loadProofs(proofsFilePath) {
    if (!fs.existsSync(proofsFilePath)) {
        throw new Error(`Proofs file not found: ${proofsFilePath}`);
    }
    
    const proofsContent = fs.readFileSync(proofsFilePath, 'utf8');
    return JSON.parse(proofsContent);
}

/**
 * Verify a proof for a specific address
 * @param {string} address - The address to verify
 * @param {Object} proofsData - The loaded proofs data
 * @returns {Object} Verification result
 */
function verifyAddressProof(address, proofsData) {
    const normalizedAddress = ethers.getAddress(address);
    
    if (!proofsData.proofs[normalizedAddress]) {
        return {
            valid: false,
            error: 'Address not found in merkle tree'
        };
    }
    
    const { amount, proof } = proofsData.proofs[normalizedAddress];
    
    const isValid = verifyProof(
        normalizedAddress,
        amount,
        proof,
        proofsData.merkleRoot
    );
    
    return {
        valid: isValid,
        address: normalizedAddress,
        amount: amount,
        proof: proof,
        root: proofsData.merkleRoot
    };
}

/**
 * Get proof data for frontend/claiming
 * @param {string} address - The address to get proof for
 * @param {Object} proofsData - The loaded proofs data
 * @returns {Object} Proof data for claiming
 */
function getClaimData(address, proofsData) {
    const result = verifyAddressProof(address, proofsData);
    
    if (!result.valid) {
        return result;
    }
    
    return {
        valid: true,
        claimData: {
            address: result.address,
            amount: result.amount,
            merkleProof: result.proof
        },
        formattedAmount: ethers.formatEther(result.amount)
    };
}

/**
 * Main function
 */
async function main() {
    const args = process.argv.slice(2);
    
    if (args.length < 2) {
        console.log('Usage: node verifyMerkleProof.js <proofs-file> <address>');
        console.log('');
        console.log('Example:');
        console.log('  node scripts/verifyMerkleProof.js merkle-output/merkleProofs.json 0x742d35Cc6634C0532925a3b8D4aEa4f3eB4FaF88');
        process.exit(1);
    }
    
    const proofsFilePath = args[0];
    const address = args[1];
    
    try {
        console.log(`Loading proofs from: ${proofsFilePath}`);
        const proofsData = loadProofs(proofsFilePath);
        
        console.log(`Verifying proof for address: ${address}`);
        const result = verifyAddressProof(address, proofsData);
        
        if (result.valid) {
            console.log('Proof is VALID');
            console.log(`Address: ${result.address}`);
            console.log(`Amount: ${ethers.formatEther(result.amount)} ETH (${result.amount} wei)`);
            console.log(`Merkle Root: ${result.root}`);
            console.log(`Proof: ${JSON.stringify(result.proof)}`);
            
            console.log('\nClaim data (for frontend):');
            const claimData = getClaimData(address, proofsData);
            console.log(JSON.stringify(claimData.claimData, null, 2));
        } else {
            console.log('Proof is INVALID');
            console.log(`Error: ${result.error}`);
        }
        
    } catch (error) {
        console.error('Error verifying proof:', error.message);
        process.exit(1);
    }
}

// Export functions
module.exports = {
    loadProofs,
    verifyAddressProof,
    getClaimData
};

// Run main function if this script is executed directly
if (require.main === module) {
    main().catch(console.error);
} 