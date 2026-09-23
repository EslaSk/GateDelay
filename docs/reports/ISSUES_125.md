# GateDelay Issue Backlog

Total issues: 125

## Frontend Issues

1. FRONTEND-Improve market list loading, empty, and error states
2. FRONTEND-Add mobile-first layout polish for the dashboard route
3. FRONTEND-Fix wallet connect unavailable state when Particle credentials are missing
4. FRONTEND-Add retry controls for failed WebSocket price subscriptions
5. FRONTEND-Create reusable market status badge variants for active, paused, resolved, and cancelled markets
6. FRONTEND-Add accessibility labels to icon-only wallet and trade controls
7. FRONTEND-Improve trade confirmation copy for slippage, fees, and wallet signature steps
8. FRONTEND-Add skeleton loading to market detail charts and order book panels
9. FRONTEND-Add client-side validation to the create market form
10. FRONTEND-Add route-level error boundaries to bridge, audit, wallet, and analytics pages
11. FRONTEND-Add pagination and sorting controls to transaction history
12. FRONTEND-Improve keyboard navigation in token selector and pair selector modals
13. FRONTEND-Add optimistic favorite toggling with rollback on API failure
14. FRONTEND-Add toast notifications for successful deposits, withdrawals, and trades
15. FRONTEND-Add stale-price warning to trading panels when WebSocket updates stop
16. FRONTEND-Replace hard-coded mock market fallbacks with typed fixture loading
17. FRONTEND-Add test coverage for market search filtering and category navigation
18. FRONTEND-Improve dark mode contrast for cards, tables, and chart tooltips
19. FRONTEND-Add responsive overflow handling for order book rows on small screens
20. FRONTEND-Add CSV export loading state and failure handling
21. FRONTEND-Add wallet network mismatch banner with switch action
22. FRONTEND-Add pending transaction drawer with confirmations and failure reasons
23. FRONTEND-Improve portfolio widget calculations for unsettled positions
24. FRONTEND-Add empty-state guidance for watchlists and favorite markets
25. FRONTEND-Add form-level validation messages to withdrawal and emergency withdrawal flows
26. FRONTEND-Add bridge transaction status timeline to the bridge page
27. FRONTEND-Add market metadata preview before IPFS upload
28. FRONTEND-Add retry and cancel actions to IPFS upload failures
29. FRONTEND-Improve analytics page chart legends, date filters, and loading behavior
30. FRONTEND-Add notification preferences UI connected to backend settings
31. FRONTEND-Add API key management copy, masking, and revoke confirmation states
32. FRONTEND-Add audit log filters for event type, actor, market, and date range
33. FRONTEND-Add multisig proposal confirmation details before submission
34. FRONTEND-Add settlement result preview for market resolution actions
35. FRONTEND-Improve dispute interface with evidence upload status and validation
36. FRONTEND-Add offline mode banner and reconnect progress indicator
37. FRONTEND-Add latency indicator thresholds and tooltip explanations
38. FRONTEND-Add reusable number formatting utilities for odds, liquidity, and volume
39. FRONTEND-Add localization-ready labels for market outcomes and order states
40. FRONTEND-Add Playwright smoke coverage for wallet, market detail, and trade routes
41. FRONTEND-Add unit tests for bridge API base URL and error parsing
42. FRONTEND-Add contract address validation to frontend environment startup checks
43. FRONTEND-Improve create market flow with flight search autocomplete failure states
44. FRONTEND-Add governance proposal list filters and voting eligibility messages
45. FRONTEND-Add profile page wallet activity summary and account safety reminders
46. FRONTEND-Add accessible modal focus traps to wallet, trade, and multisig dialogs
47. FRONTEND-Add chart fallback when Recharts cannot render in constrained containers
48. FRONTEND-Add route handler tests for market audit, sentiment, IPFS, and multisig APIs
49. FRONTEND-Improve Docker build documentation for environment-specific client variables
50. FRONTEND-Add end-to-end regression test for archive page filtering and retry behavior

## Backend Issues

51. BACKEND-Consolidate Express and NestJS startup documentation into one canonical runbook
52. BACKEND-Add health checks for MongoDB, Redis, RPC, AviationStack, and AI provider dependencies
53. BACKEND-Add request correlation IDs across controllers, routes, jobs, and logs
54. BACKEND-Add structured error envelopes for all REST endpoints
55. BACKEND-Add OpenAPI documentation for NestJS modules and legacy Express routes
56. BACKEND-Add authentication guard coverage to sensitive AML, approvals, and blacklist endpoints
57. BACKEND-Add role-based authorization policies for market admin and settlement routes
58. BACKEND-Add integration tests for archive markets endpoint consumed by the frontend
59. BACKEND-Add WebSocket heartbeat and reconnect metrics for price gateway clients
60. BACKEND-Add rate-limit configuration validation at startup
61. BACKEND-Add Redis-backed idempotency keys for trade placement and settlement requests
62. BACKEND-Add background job retry limits and dead-letter logging
63. BACKEND-Add audit trail entries for market creation, resolution, pause, and rollback actions
64. BACKEND-Add input validation DTOs for legacy Express route payloads
65. BACKEND-Add pagination metadata to list endpoints for markets, trades, audit logs, and notifications
66. BACKEND-Add database indexes for market status, flight number, close time, and user wallet queries
67. BACKEND-Add stale oracle data detection before price-sensitive trade execution
68. BACKEND-Add sanity checks for market migration status before server startup
69. BACKEND-Add circuit breaker integration to trading and bridge service calls
70. BACKEND-Add graceful shutdown handling for workers, WebSocket gateway, and database clients
71. BACKEND-Add centralized environment schema validation for all required secrets and URLs
72. BACKEND-Add API version deprecation headers and migration guidance for v1 clients
73. BACKEND-Add replay protection for signed wallet and multisig requests
74. BACKEND-Add notification templates for trade filled, dispute opened, and market resolved events
75. BACKEND-Add e2e tests for wallet backup, restore, and emergency withdrawal APIs
76. BACKEND-Add monitoring metrics for trade engine latency, failed jobs, and provider errors
77. BACKEND-Add fallback handling for AviationStack outages and missing flight data
78. BACKEND-Add cache invalidation rules for market metadata, categories, and trending markets
79. BACKEND-Add validation for IPFS hashes before gateway, pin, and retrieve operations
80. BACKEND-Add bridge transaction reconciliation job for stuck or failed cross-chain transfers
81. BACKEND-Add liquidation service tests for margin threshold and collateral edge cases
82. BACKEND-Add risk score explainability fields for frontend AI analysis panels
83. BACKEND-Add trade reconciliation alerts when on-chain and database state diverge
84. BACKEND-Add endpoint-level permission tests for admin, user, and unauthenticated access
85. BACKEND-Add database migration rollback smoke test and fixture data
86. BACKEND-Add abuse detection for high-frequency search, quote, and market audit requests
87. BACKEND-Add webhook signature verification and replay window enforcement
88. BACKEND-Add service-level tests for market sentiment and market audit modules
89. BACKEND-Add operational runbooks for failed deploy, rollback, and circuit breaker activation
90. BACKEND-Add contract ABI version checks before starting contract-facing services

## Contract Issues

91. CONTRACT-Decide and document LMSR versus CLOB ownership for core trading flow
92. CONTRACT-Add deploy script coverage for RoleManager, FeeHandler, CircuitBreaker, and core market contracts
93. CONTRACT-Add full forge test target once unrelated parsing and type errors are resolved
94. CONTRACT-Add invariant tests for LMSR pricing, liquidity, and payout conservation
95. CONTRACT-Add access-control tests for every privileged function across market contracts
96. CONTRACT-Add pause and unpause coverage for market trading, minting, bridge, and settlement paths
97. CONTRACT-Add events for all admin, risk, settlement, fee, and bridge configuration changes
98. CONTRACT-Add NatSpec comments to public and external functions missing integration guidance
99. CONTRACT-Add gas snapshots for trade, settle, resolve, bridge, mint, and withdraw flows
100. CONTRACT-Add deployment address registry artifact consumed by backend and frontend
101. CONTRACT-Add constructor validation for zero addresses, invalid basis points, and empty dependencies
102. CONTRACT-Add fee recipient sum validation tests for FeeHandler edge cases
103. CONTRACT-Add role handoff runbook and tests for deployer admin transfer
104. CONTRACT-Add slippage and max-cost enforcement tests for Trading and MarketMaker flows
105. CONTRACT-Add oracle freshness enforcement before resolution and payout execution
106. CONTRACT-Add reentrancy coverage for withdrawal, payout, bridge, and flash borrow functions
107. CONTRACT-Add fuzz tests for market cap, supply controller, and minting pause boundaries
108. CONTRACT-Add upgrade authorization tests for UUPS and proxy-managed contracts
109. CONTRACT-Add storage layout documentation for upgradeable market contracts
110. CONTRACT-Add emergency stop tests for active trades, pending withdrawals, and settlement attempts
111. CONTRACT-Add cross-chain relay failure handling tests for retry, refund, and duplicate delivery
112. CONTRACT-Add liquidation math tests for rounding, collateral ratios, and partial liquidation
113. CONTRACT-Add vote delegation tests for delegation loops, revoke behavior, and vote weight snapshots
114. CONTRACT-Add governance quorum tests for edge cases around abstain votes and late voting
115. CONTRACT-Add dispute lifecycle tests for evidence, appeal, ruling timelock, and verdict execution
116. CONTRACT-Add bridge connector tests for unsupported chain IDs and malformed payloads
117. CONTRACT-Add market factory tests for deterministic market IDs and duplicate flight markets
118. CONTRACT-Add payout tests for cancelled, delayed, on-time, and unresolved flight outcomes
119. CONTRACT-Add withdrawal queue tests for ordering, limits, and claim expiration
120. CONTRACT-Add blacklist and whitelist interaction tests for restricted trading and withdrawals
121. CONTRACT-Add coverage tier tests for premium calculation and claim eligibility boundaries
122. CONTRACT-Add flash loan protection tests around same-block manipulation and nested calls
123. CONTRACT-Add deployment verification script for ABI generation and address export
124. CONTRACT-Add contract-to-backend integration checklist for emitted events and expected DTO fields
125. CONTRACT-Add security review checklist for roles, oracle trust, upgrade keys, and emergency controls
