# Directory

```text
agent-gateway/
├── .env.example
├── .gitignore
├── README.md
├── package.json
├── package-lock.json
├── docs/
│   ├── DIRECTORY.md
│   ├── MARKETING.md
│   ├── PAYMENTS.md
│   └── WHITEPAPER.md
├── src/
│   ├── app.ts
│   ├── devnet-payment.ts
│   ├── inspection.ts
│   └── main.ts
└── test/
    └── gateway.test.ts
```

The implementation imports the parent repository's `engine/client/wallet.ts` and its dependencies; this is not yet a portable standalone repository.
