This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

## Claude + Helius MCP Chat Setup

Create a `.env` file in the project root and add:

```bash
ANTHROPIC_API_KEY=your_anthropic_api_key
# Optional override (default: claude-sonnet-4-5)
ANTHROPIC_MODEL=claude-sonnet-4-5
# Optional low-cost planner/repair split
ANTHROPIC_MODEL_PLANNER=claude-3-5-haiku-20241022
ANTHROPIC_MODEL_REPAIR=claude-3-5-haiku-20241022
# Optional token caps for cost control
ANTHROPIC_MAX_TOKENS_PLANNER=320
ANTHROPIC_MAX_TOKENS_REPAIR=220
```

Then restart the dev server so the environment variables are loaded.

The in-app chat can propose and auto-add one or more workflow nodes. Node creation is gated by the local method registry: if Claude suggests an RPC method that is not available in this app (or required args are missing), the node plan will not be added.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
