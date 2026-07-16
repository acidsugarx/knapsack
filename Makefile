.PHONY: dev test check fix clean

# Run pi with knapsack auto-loaded from .pi/extensions/
dev:
	pi --approve

# Run pi with explicit extension path (faster, no auto-discovery needed)
dev-explicit:
	pi --approve -e ./src/index.ts

# Run tests
test:
	npx vitest run

# Run tests in watch mode
test-watch:
	npx vitest

# Lint + format check
check:
	npx biome check .

# Auto-fix lint + format
fix:
	npx biome check --write .

# Clean build artifacts
clean:
	rm -rf dist/
