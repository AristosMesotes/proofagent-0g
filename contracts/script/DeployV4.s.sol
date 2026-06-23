// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.26;

import {MandateRegistryV4} from "../src/MandateRegistryV4.sol";

// =================================================================================================
// DeployV4 -- the Foundry deploy script for the CONSOLIDATED, HARDENED spend gate {MandateRegistryV4}.
//
// Design SS2 (Rails) / SS4 (contracts/script): deploys the consolidated mandate to 0G and broadcasts it,
// reading EVERY parameter from the environment (nothing sensitive is hardcoded; the RPC endpoint and the
// deployer key come from the env, never the source). The script targets 0G only and REFUSES to broadcast
// against any other chain (see {WrongChain}), so the mandate can never be deployed to an unintended
// network by accident (design SS8: testnet/dev only for live legs).
//
// The MandateRegistryV4 is ADVISORY + verifier-enforced + NON-CUSTODIAL -- it holds NO funds, so it is
// fully deployable + demoable on the 0G Galileo TESTNET (16602) at $0 (it is your own contract).
//
// THE EXACT OPERATOR COMMAND:
//
//   set -a; . ./.env; set +a                       # OG_RPC_TESTNET / demo wallet from the gitignored .env
//   MANDATE_OWNER=<demo-wallet> MANDATE_AGENT=<demo-wallet> MANDATE_GUARDIAN=<a-DIFFERENT-key> \
//   MANDATE_PER_TX_CAP=2000000 \                    # 2 USD-equiv per-tx cap, MINOR units (wei)
//   MANDATE_START=0 MANDATE_EXPIRY=18446744073709551615 \   # active now; never expires (uint64 max)
//   MANDATE_PERIOD_SECONDS=3600 MANDATE_PERIOD_CAP=1500000 \  # leaky-bucket: 1.5M / hour (looping guard)
//   MANDATE_ASSET_CAP=2000000 \                     # the native sentinel's per-asset sub-cap
//   MANDATE_PARAM_DELAY=86400 \                     # 24h delay on risk-INCREASING owner ops
//   OG_RPC=$OG_RPC_TESTNET \
//   forge script script/DeployV4.s.sol:DeployV4 --rpc-url og --broadcast --private-key $PRIVATE_KEY
//
// After a confirmed broadcast, pin the deployed address into proofagent.toml [mandate_v4].address
// (claim only what's live -- design SS8). The deployer's PRIVATE_KEY is supplied to `forge script` via the
// CLI/env and is NEVER read or printed by this contract. The GUARDIAN must differ from the OWNER (the
// constructor enforces it -- a separate blast-radius role).
// =================================================================================================

/// @dev Minimal inline cheatcode interface -- the repo vendors NO external Solidity libraries (clean-room
///      / offline-by-default), so we declare only the handful of Foundry cheatcodes this script needs.
interface IVm {
    function envAddress(string calldata name) external view returns (address);
    function envOr(string calldata name, uint256 defaultValue) external view returns (uint256);
    function envOr(string calldata name, address defaultValue) external view returns (address);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @title DeployV4 -- deploy + tier-configure the consolidated {MandateRegistryV4} on 0G (advisory,
///        non-custodial). Guards the active chain id FIRST so it can only broadcast to 0G.
contract DeployV4 {
    IVm internal constant VM = IVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice The canonical native-0G sentinel (a token of this address is the native asset, decimals 18).
    address internal constant NATIVE = 0x0000000000000000000000000000000000000001;

    /// @notice 0G Aristotle mainnet chain id (proofagent.toml [chain].id).
    uint256 internal constant OG_MAINNET_CHAIN_ID = 16661;
    /// @notice 0G Galileo testnet chain id (proofagent.toml [chain].testnet).
    uint256 internal constant OG_TESTNET_CHAIN_ID = 16602;

    /// @dev Reverts if the active chain is neither 0G mainnet nor 0G testnet (the on-chain half of SS8).
    error WrongChain(uint256 actual);

    /// @notice Deploy {MandateRegistryV4} to 0G with all parameters drawn from the environment, then
    ///         allowlist the native sentinel + set the leaky-bucket period config + the param-delay, so the
    ///         live testnet demo runs immediately. Guards the active chain id FIRST.
    /// @return registry The freshly-deployed consolidated mandate (its address is logged by `forge script`).
    function run() external returns (MandateRegistryV4 registry) {
        // (0) Chain guard -- target 0G only (design SS8).
        requireOgChain(block.chainid);

        address owner = VM.envAddress("MANDATE_OWNER");
        address agent = VM.envAddress("MANDATE_AGENT");
        address guardian = VM.envAddress("MANDATE_GUARDIAN");
        uint256 perTxCap = VM.envOr("MANDATE_PER_TX_CAP", uint256(0));
        uint256 startTs = VM.envOr("MANDATE_START", uint256(0));
        uint256 expiry = VM.envOr("MANDATE_EXPIRY", uint256(type(uint64).max));

        uint256 assetCap = VM.envOr("MANDATE_ASSET_CAP", uint256(0));
        uint256 periodSeconds = VM.envOr("MANDATE_PERIOD_SECONDS", uint256(0));
        uint256 periodCap = VM.envOr("MANDATE_PERIOD_CAP", uint256(0));
        uint256 paramDelay = VM.envOr("MANDATE_PARAM_DELAY", uint256(0));

        VM.startBroadcast();
        // The env-supplied time/period params are uint64 fields on the registry; the operator supplies
        // sane values (these casts are intentional narrowing of operator-controlled deploy config).
        // forge-lint: disable-next-line(unsafe-typecast)
        registry = new MandateRegistryV4(owner, agent, guardian, perTxCap, uint64(startTs), uint64(expiry));
        // Configure the demoable tiers from the deployer (owner == demo wallet), same broadcast.
        if (assetCap != 0) {
            // The native sentinel skips the live decimals() read (decimals pinned to 18 at construction).
            registry.addAllowedAsset(NATIVE, assetCap, 18);
        }
        if (periodSeconds != 0 && periodCap != 0) {
            // forge-lint: disable-next-line(unsafe-typecast)
            registry.setPeriodConfig(uint64(periodSeconds), periodCap); // the leaky-bucket looping guard.
        }
        if (paramDelay != 0) {
            // forge-lint: disable-next-line(unsafe-typecast)
            registry.setParamDelay(uint64(paramDelay)); // delay on risk-increasing owner ops.
        }
        VM.stopBroadcast();
    }

    /// @notice Target-chain guard: reverts with {WrongChain} unless `chainId` is 0G mainnet (16661) or 0G
    ///         testnet (16602). Pure + self-contained so the safety invariant is unit-testable.
    function requireOgChain(uint256 chainId) public pure {
        if (chainId != OG_MAINNET_CHAIN_ID && chainId != OG_TESTNET_CHAIN_ID) {
            revert WrongChain(chainId);
        }
    }
}
