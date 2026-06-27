// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.26;

import {AgentIdentity} from "../src/AgentIdentity.sol";

// DeployAgentIdentity -- deploy the ERC-7857 Agentic-ID iNFT to 0G and mint ProofAgent's sovereign identity.
//
// Design SS9 (Agentic ID) / SS4 (contracts/script): deploys {AgentIdentity} and mints token #1, binding -- from
// the environment, nothing sensitive hardcoded -- the agent EOA, the live MandateRegistry (rails), the 0G Compute
// TEE attestation oracle (verifier), the attested model, and the 0G Storage rootHash of the encrypted mind. Guards
// the active chain id FIRST so it can only broadcast to 0G (mainnet 16661 / Galileo testnet 16602). Testnet-only by
// project policy -- AIverse mainnet listing is an operator decision, not this script's job.
//
// Usage (Galileo testnet, $0 -- your own contract):
//   set -a; . ./.env; set +a
//   AGENTID_ISSUER=$WALLET_ADDRESS \                 # the mint authority (the deployer/launchpad)
//   AGENTID_AGENT=$WALLET_ADDRESS \                  # the EOA the agent acts from
//   AGENTID_MANDATE=0x8e561a5cc096af6e570220a5228b33c7d889f774 \   # the live MandateRegistryV4 (rails)
//   AGENTID_VERIFIER=$WALLET_ADDRESS \               # the TEE attestation oracle (signs re-seal proofs)
//   AGENTID_SEAL=0x6b51c075fccac9fff9ab461fee61252d93cd676010ffcb5f79972d8432fe3f6b \  # the mind on 0G Storage
//   AGENTID_MODEL="qwen/qwen2.5-omni-7b" \
//   OG_RPC=$OG_RPC_TESTNET \
//   forge script script/DeployAgentIdentity.s.sol:DeployAgentIdentity --rpc-url og --broadcast --private-key $PRIVATE_KEY
//
// After a confirmed broadcast, pin the deployed address + tokenId into proofagent.toml [agent_id] + web/src/spine.ts.

/// @dev Minimal inline cheatcode interface (clean-room -- no forge-std).
interface IVm {
    function envAddress(string calldata name) external view returns (address);
    function envString(string calldata name) external view returns (string memory);
    function envBytes32(string calldata name) external view returns (bytes32);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @title DeployAgentIdentity -- deploy {AgentIdentity} + mint ProofAgent's Agentic ID on 0G.
/// @notice Guards the chain id FIRST (0G only), then deploys with the env-supplied issuer and mints token #1.
contract DeployAgentIdentity {
    IVm internal constant VM = IVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice 0G Aristotle mainnet chain id.
    uint256 internal constant OG_MAINNET_CHAIN_ID = 16661;
    /// @notice 0G Galileo testnet chain id.
    uint256 internal constant OG_TESTNET_CHAIN_ID = 16602;

    /// @dev Reverts if the active chain is neither 0G mainnet nor 0G testnet (the on-chain half of SS8).
    error WrongChain(uint256 actual);

    /// @notice Deploy {AgentIdentity} (issuer = AGENTID_ISSUER) and mint token #1 binding the agent / mandate /
    ///         verifier / model / sealed mind from the environment. The broadcaster MUST equal AGENTID_ISSUER
    ///         (so the in-script mint passes the issuer gate).
    /// @return identity The freshly-deployed Agentic-ID collection.
    /// @return tokenId  The minted ProofAgent identity id (1).
    function run() external returns (AgentIdentity identity, uint256 tokenId) {
        requireOgChain(block.chainid);

        address issuer = VM.envAddress("AGENTID_ISSUER");
        address agent = VM.envAddress("AGENTID_AGENT");
        address mandate = VM.envAddress("AGENTID_MANDATE");
        address verifier = VM.envAddress("AGENTID_VERIFIER");
        bytes32 seal = VM.envBytes32("AGENTID_SEAL");
        string memory model = VM.envString("AGENTID_MODEL");

        VM.startBroadcast();
        identity = new AgentIdentity(issuer);
        tokenId = identity.mint(agent, agent, mandate, verifier, seal, model);
        VM.stopBroadcast();
    }

    /// @notice Target-chain guard: reverts with {WrongChain} unless `chainId` is 0G mainnet or testnet. Pure +
    ///         self-contained so the safety invariant is unit-testable.
    function requireOgChain(uint256 chainId) public pure {
        if (chainId != OG_MAINNET_CHAIN_ID && chainId != OG_TESTNET_CHAIN_ID) {
            revert WrongChain(chainId);
        }
    }
}
