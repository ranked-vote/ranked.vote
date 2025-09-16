#!/bin/bash

# Generate share images locally
# This script starts the dev server, generates images, then stops the server

echo "🚀 Starting local share image generation..."

# Start dev server in background
echo "Starting dev server..."
RANKED_VOTE_REPORTS="report_pipeline/reports" npm run dev &
DEV_PID=$!

# Wait for server to be ready
echo "Waiting for dev server to be ready..."
sleep 5

# Check if server is running (try both ports)
if ! curl -s http://localhost:3000 >/dev/null && ! curl -s http://localhost:3001 >/dev/null; then
	echo "❌ Dev server failed to start"
	kill "${DEV_PID}" 2>/dev/null
	exit 1
fi

echo "✅ Dev server is ready"

# Generate share images
echo "Generating share images..."
npm run generate-share-images

# Count generated images
IMAGE_COUNT=$(find static/share -name "*.png" 2>/dev/null | wc -l)
echo "📊 Generated ${IMAGE_COUNT} share images"

# Stop dev server
echo "Stopping dev server..."
kill "${DEV_PID}" 2>/dev/null

echo "✅ Share image generation complete!"
