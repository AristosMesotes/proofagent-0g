// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MandateRegistryV3} from "../src/MandateRegistryV3.sol";

// =================================================================================================
// DeployV3 -- the Foundry deploy script for the four-tier production spend gate {MandateRegistryV3}.
//
// Design SS2 (Rails) / SS4 (contracts/script): deploys the production mandate to 0G and broadcasts it,
// reading EVERY parameter from the environment (design SS3 principle 6: nothing sensitive is hardcoded;
// the RPC endpoint and the deployer key come from the env, never the source). The script targets 0G
// only and REFUSES to broadcast against any other chain (see {WrongChain}), so the mandate can never be
// deployed to an unintended network by accident (design SS8: testnet/dev only for live legs).
//
// THE EXACT OPERATOR COMMAND (this script deploys to the Galileo TESTNET 16602 at $0 -- the mandate is
// YOUR OWN contract, fully demoable on testnet, unlike the money-bearing DeFi legs):
//
//   set -a; . ./.env; set +a                       # OG_RPC_TESTNET / demo wallet from the gitignored .env
//   MANDATE_OWNER=<demo-wallet> MANDATE_AGENT=<demo-wallet> \
//   MANDATE_PER_TX_CAP=2000000 \                    # 2 USD-equiv per-tx cap, MINOR units (wei)
//   MANDATE_PERIOD_SECONDS=3600 MANDATE_PERIOD_CAP=1500000 \  # Tier 1: 1.5M / hour (the looping guard)
//   MANDATE_NATIVE_SENTINEL=0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE \  # allowlisted asset
//   MANDATE_ASSET_CAP=2000000 \                     # the sentinel's per-asset sub-cap
//   OG_RPC=$OG_RPC_TESTNET \
//   forge script script/DeployV3.s.sol:DeployV3 --rpc-url og --broadcast --private-key $PRIVATE_KEY
//
// After a confirmed broadcast, pin the deployed address into proofagent.toml [mandate_v3].address
// (claim only what's live -- design SS8). The deployer's PRIVATE_KEY is supplied to `forge script` via
// the CLI/env and is NEVER read or printed by this contract.
// =================================================================================================

/// @dev Minimal inline cheatcode interface -- the repo vendors NO external Solidity libraries
///      (clean-room / offline-by-default, design SS3 principle 6 / SS6), so we declare only the handful
///      of Foundry cheatcodes this script needs. The cheatcode address is Foundry's well-known VM
///      address `address(uint160(uint256(keccak256("hevm cheat code"))))` -- no hardcoded magic literal.
interface IVm {
    function envAddress(string calldata name) external view returns (address);
    function envOr(string calldata name, uint256 defaultValue) external view returns (uint256);
    function envOr(string calldata name, address defaultValue) external view returns (address);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @title DeployV3 -- deploy + tier-configure {MandateRegistryV3} on 0G (design SS2 Rails, four-tier).
contract DeployV3 {
    IVm internal constant VM = IVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice 0G Aristotle mainnet chain id (proofagent.toml [chain].id).
    uint256 internal constant OG_MAINNET_CHAIN_ID = 16661;
    /// @notice 0G Galileo testnet chain id (proofagent.toml [chain].testnet).
    uint256 internal constant OG_TESTNET_CHAIN_ID = 16602;

    /// @dev Reverts if the active chain is neither 0G mainnet nor 0G testnet. A money-bearing mandate
    ///      must never be broadcast to the wrong network -- the on-chain half of design SS8.
    error WrongChain(uint256 actual);

    /// @notice Deploy {MandateRegistryV3} to 0G with all parameters drawn from the environment, then
    ///         configure the demoable tiers (allowlist the native sentinel asset + set the Tier-1 period
    ///         cap) so the live testnet demo runs immediately. Guards the active chain id FIRST.
    /// @return registry The freshly-deployed mandate (its address is logged by `forge script`).
    function run() external returns (MandateRegistryV3 registry) {
        // (0) Chain guard -- target 0G only (design SS8).
        requireOgChain(block.chainid);

        address owner = VM.envAddress("MANDATE_OWNER");
        address agent = VM.envAddress("MANDATE_AGENT");
        uint256 perTxCap = VM.envOr("MANDATE_PER_TX_CAP", uint256(0));
        uint256 expiry = VM.envOr("MANDATE_EXPIRY", type(uint256).max);

        // Tier-1 (period cap) + Tier-3 (asset allowlist) config, all from the env with safe defaults.
        address sentinel = VM.envOr("MANDATE_NATIVE_SENTINEL", address(0));
        uint256 assetCap = VM.envOr("MANDATE_ASSET_CAP", uint256(0));
        uint256 periodSeconds = VM.envOr("MANDATE_PERIOD_SECONDS", uint256(0));
        uint256 periodCap = VM.envOr("MANDATE_PERIOD_CAP", uint256(0));

        VM.startBroadcast();
        registry = new MandateRegistryV3(owner, agent, perTxCap, expiry);
        // Configure the demoable tiers from the deployer (the owner == the demo wallet). The owner-gated
        // mutators are called in the same broadcast so the registry is live + demoable immediately.
        if (sentinel != address(0)) {
            registry.setAssetCap(sentinel, assetCap, true); // Tier 3: allowlist + sub-cap the sentinel
        }
        if (periodSeconds != 0 && periodCap != 0) {
            registry.setPeriodConfig(periodSeconds, periodCap); // Tier 1: the looping-drain guard
        }
        VM.stopBroadcast();
    }

    /// @notice Target-chain guard: reverts with {WrongChain} unless `chainId` is 0G mainnet (16661) or
    ///         0G testnet (16602). Pure + self-contained so the safety invariant is unit-testable.
    function requireOgChain(uint256 chainId) public pure {
        if (chainId != OG_MAINNET_CHAIN_ID && chainId != OG_TESTNET_CHAIN_ID) {
            revert WrongChain(chainId);
        }
    }
}
