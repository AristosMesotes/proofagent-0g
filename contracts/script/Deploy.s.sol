// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.26;

import {MandateRegistry} from "../src/MandateRegistry.sol";

// =================================================================================================
// STATUS: BUILT, NOT DEPLOYED (design SS8 honesty doctrine -- "claim only what is live").
// This script compiles and is ready to broadcast, but NO live deployment has been performed from it.
// The live deploy needs a FUNDED deployer wallet on 0G and is OPERATOR-GATED -- it is intentionally
// not run here. There is no on-chain mandate address to pin yet; `proofagent.toml [mandate].address`
// stays empty until a real deploy is confirmed on-chain (design SS6/SS9: "pinned once confirmed").
// =================================================================================================

/// @dev Minimal inline cheatcode interface. The repo vendors NO external Solidity libraries
///      (clean-room / offline-by-default, design SS3 principle 6 / SS6), so we declare only the
///      handful of Foundry cheatcodes this script needs instead of importing forge-std's `Script`.
///      The cheatcode address is derived as `address(uint160(uint256(keccak256("hevm cheat code"))))`,
///      Foundry's well-known VM address -- no hardcoded magic literal.
interface IVm {
    function envAddress(string calldata name) external view returns (address);
    function envOr(string calldata name, uint256 defaultValue) external view returns (uint256);
    function envOr(string calldata name, address defaultValue) external view returns (address);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @title Deploy -- Foundry deploy script for {MandateRegistry} (design SS4: contracts/script/Deploy.s.sol).
///
/// @notice Deploys the on-chain spend mandate (the Rails proof, design SS2) to 0G and broadcasts it,
///         reading EVERY parameter from the environment (design SS3 principle 6: nothing sensitive is
///         hardcoded; the RPC endpoint and the deployer key come from the env, never the source). The
///         script targets 0G only and REFUSES to broadcast against any other chain (see {WrongChain}),
///         so the mandate can never be deployed to an unintended network by accident (design SS8:
///         testnet/dev only for live legs).
///
/// @dev    -------------------------------------------------------------------------------------------
///         THE EXACT COMMAND (documented per the build spec; this script is BUILT, NOT DEPLOYED).
///         -------------------------------------------------------------------------------------------
///         Prereqs: copy `.env.example` -> `.env` (gitignored) and fill `OG_RPC` with a 0G JSON-RPC
///         URL and the deploy params below. Use a FRESH demo wallet -- never a shared/product key. The
///         RPC alias `og` is defined in `contracts/foundry.toml [rpc_endpoints]` as `${OG_RPC}`.
///
///         Deploy params (read from the env by `run()`):
///           MANDATE_OWNER      (address, REQUIRED)  the mandate admin / owner
///           MANDATE_AGENT      (address, REQUIRED)  the single agent the mandate authorizes
///           MANDATE_PER_TX_CAP (uint, optional, default 0)              global per-tx cap, MINOR units
///           MANDATE_EXPIRY     (uint, optional, default type(uint256).max)  unix seconds; max == never
///
///         (1) DRY-RUN first -- simulate against the live chain WITHOUT broadcasting (no funds spent,
///             this is the honest default; nothing lands on-chain):
///               forge script script/Deploy.s.sol:Deploy --rpc-url og
///
///         (2) BROADCAST to 0G Galileo TESTNET (chain 16602) -- the live leg per design SS8
///             (testnet/dev first). The deployer key is passed to `forge` here, NEVER read in source:
///               OG_RPC=<galileo-rpc-url> \
///               forge script script/Deploy.s.sol:Deploy --rpc-url og --broadcast \
///                 --private-key $PRIVATE_KEY            # or: --ledger / --keystore <path>
///
///         (3) BROADCAST to 0G Aristotle MAINNET (chain 16661) -- only after testnet is confirmed:
///               OG_RPC=<aristotle-rpc-url> \
///               forge script script/Deploy.s.sol:Deploy --rpc-url og --broadcast \
///                 --private-key $PRIVATE_KEY
///
///         After a confirmed broadcast, pin the deployed address into `proofagent.toml`
///         `[mandate].address` (claim only what's live -- design SS8). The deployer's PRIVATE_KEY is
///         supplied to `forge script` via the CLI/env and is NEVER read or printed by this contract.
contract Deploy {
    IVm internal constant VM = IVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice 0G Aristotle mainnet chain id (design appendix; `proofagent.toml [chain].id`).
    uint256 internal constant OG_MAINNET_CHAIN_ID = 16661;
    /// @notice 0G Galileo testnet chain id (design appendix; `proofagent.toml [chain].testnet`).
    uint256 internal constant OG_TESTNET_CHAIN_ID = 16602;

    /// @dev Reverts if the active chain is neither 0G mainnet nor 0G testnet. A money-bearing mandate
    ///      must never be broadcast to the wrong network -- this is the on-chain half of design SS8
    ///      ("testnet/dev only for live legs"). `actual` is the chain id the connected RPC reported.
    error WrongChain(uint256 actual);

    /// @notice Deploy {MandateRegistry} to 0G with all parameters drawn from the environment.
    /// @dev    Guards the active chain id FIRST (a wrong-network deploy is rejected before any
    ///         broadcast), then reads the mandate params, then broadcasts the constructor. The chain
    ///         guard runs in both dry-run and `--broadcast` modes, so a misconfigured RPC fails loudly
    ///         in simulation -- never silently on-chain.
    /// @return registry  The freshly-deployed mandate (its address is logged by `forge script`).
    function run() external returns (MandateRegistry registry) {
        // (0) Chain guard -- target 0G only (design SS8). `block.chainid` is the id the connected RPC
        //     reported; reject anything that is not 0G mainnet (16661) or 0G testnet (16602).
        requireOgChain(block.chainid);

        address owner = VM.envAddress("MANDATE_OWNER");
        address agent = VM.envAddress("MANDATE_AGENT");
        // Default per-tx cap 0 == "permits nothing until the owner sets a real cap" -- safe by
        // construction (we never deploy a wide-open mandate by accident; design SS2/SS8).
        uint256 perTxCap = VM.envOr("MANDATE_PER_TX_CAP", uint256(0));
        // Default expiry: never expires. The owner can tighten it post-deploy via setExpiry.
        uint256 expiry = VM.envOr("MANDATE_EXPIRY", type(uint256).max);

        VM.startBroadcast();
        registry = new MandateRegistry(owner, agent, perTxCap, expiry);
        VM.stopBroadcast();
    }

    /// @notice Target-chain guard: reverts with {WrongChain} unless `chainId` is 0G mainnet (16661)
    ///         or 0G testnet (16602). Pure and self-contained so the load-bearing safety invariant
    ///         (design SS8: testnet/dev only for live legs) is directly unit-testable without the
    ///         env/broadcast machinery of {run}.
    /// @param chainId  The active chain id (the connected RPC's reported id, i.e. `block.chainid`).
    function requireOgChain(uint256 chainId) public pure {
        if (chainId != OG_MAINNET_CHAIN_ID && chainId != OG_TESTNET_CHAIN_ID) {
            revert WrongChain(chainId);
        }
    }
}
