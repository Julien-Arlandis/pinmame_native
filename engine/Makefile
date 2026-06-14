PINMAME_URL  := https://github.com/vpinball/pinmame.git
WORKSPACE    := workspace/pinmame_stock
PROJECT_ROOT := $(shell dirname $(realpath $(firstword $(MAKEFILE_LIST))))

.PHONY: all esp32 clean

all: $(WORKSPACE) node/node_modules
	./build/wasm_lib.sh
	./build/wasm.sh

esp32: $(WORKSPACE)
	cd esp32 && ./build_native_pinmame.sh

$(WORKSPACE):
	git clone $(PINMAME_URL) $(WORKSPACE)

node/node_modules:
	cd node && npm install --silent

clean:
	rm -rf out/ node/node_modules/
