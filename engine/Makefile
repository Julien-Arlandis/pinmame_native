PINMAME_URL := https://github.com/vpinball/pinmame.git
WORKSPACE   := workspace/pinmame_stock

.PHONY: all wasm native clean

all: $(WORKSPACE) node_modules
	./build/wasm_lib.sh
	./build/wasm.sh

native: $(WORKSPACE)
	cd esp32 && ./build_native_pinmame.sh

$(WORKSPACE):
	git clone $(PINMAME_URL) $(WORKSPACE)

node_modules:
	cd node && npm install --silent

clean:
	rm -rf out/
