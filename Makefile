NAME    := Aeolian
VERSION := 1.0.0

# Default target
.PHONY: all build run clean cross help

all: build

## build: Build stripped static binary for current platform
build:
	CGO_ENABLED=0 go build \
	  -ldflags="-s -w -X main.version=$(VERSION)" \
	  -trimpath \
	  -o $(NAME) .
	@echo "Built: $(NAME) ($$(du -sh $(NAME) | cut -f1))"

## run: Build & run on port 7070
run: build
	./$(NAME) -port 7070

## dev: Run with hot-reload hint (requires entr)
dev:
	find . -name '*.go' | entr -r go run . -port 7070

## cross: Build for Linux / macOS / Windows (amd64 + arm64)
cross:
	@mkdir -p dist
	GOOS=linux   GOARCH=amd64  CGO_ENABLED=0 go build -ldflags="-s -w" -trimpath -o dist/$(NAME)-linux-amd64    .
	GOOS=linux   GOARCH=arm64  CGO_ENABLED=0 go build -ldflags="-s -w" -trimpath -o dist/$(NAME)-linux-arm64    .
	GOOS=darwin  GOARCH=amd64  CGO_ENABLED=0 go build -ldflags="-s -w" -trimpath -o dist/$(NAME)-darwin-amd64   .
	GOOS=darwin  GOARCH=arm64  CGO_ENABLED=0 go build -ldflags="-s -w" -trimpath -o dist/$(NAME)-darwin-arm64   .
	GOOS=windows GOARCH=amd64  CGO_ENABLED=0 go build -ldflags="-s -w" -trimpath -o dist/$(NAME)-windows-amd64.exe .
	@echo "Cross-compiled binaries in dist/:"
	@ls -lh dist/

## clean: Remove built artifacts
clean:
	rm -f $(NAME) dist/$(NAME)-*

## help: Show this help
help:
	@grep -E '^## ' Makefile | sed 's/## //'
