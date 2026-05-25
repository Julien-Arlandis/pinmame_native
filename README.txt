Pour compiler le projet et son binaire xpinmame.x11 :
./build_native_exec.sh

Pour générer la librairie libpinmame_native.a :
./build_native_lib.sh


Pour générer un binaire d'exécution à partir de la librairie :
./build_exec_with_lib.sh

Pour lancer l'émulateur :
./test_pure_lib_exec/test_pure_lib -rompath ./roms bonebstr