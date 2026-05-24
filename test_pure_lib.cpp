#include <iostream>
#include <cstdlib>
#include <unistd.h>
#include <sys/wait.h>

int main() {
    std::cout << "=== RUNNING NATIVE VISUAL LAUNCHER ===" << std::endl;
    std::cout << "[*] Configuration automatique de l'environnement graphique..." << std::endl;
    
    // 1. On force la variable DISPLAY sur le canal :3 qui fonctionne sur ton Arch
    setenv("DISPLAY", ":3", 1);
    
    // 2. On ajoute les variables de compatibilité XWayland pour blinder l'affichage GNOME/KDE
    setenv("GDK_BACKEND", "x11", 1);
    setenv("QT_QPA_PLATFORM", "xcb", 1);
    
    std::cout << "[🚀] Lancement du moteur PinMAME officiel (bonebstr)..." << std::endl;
    std::cout << "--------------------------------------------------" << std::endl;
    
    // 3. On fork pour lancer l'exécutable officiel qui possède toute la logique X11 d'origine
    pid_t pid = fork();
    if (pid == 0) {
        // Code du processus fils : on execute le binaire officiel avec ses arguments
        char* binary_path = (char*)"./test_native_exec/xpinmame.x11";
        char* args[] = {
            binary_path,
            (char*)"-rompath",
            (char*)"./roms",
            (char*)"bonebstr",
            nullptr
        };
        
        execv(binary_path, args);
        
        // Si execv échoue, on affiche l'erreur
        std::cerr << "❌ Erreur critique : Impossible de lancer le binaire officiel !" << std::endl;
        exit(1);
    } else if (pid > 0) {
        // Code du processus père : il attend que tu fermes le flipper (Touche Échap)
        int status;
        waitpid(pid, &status, 0);
        std::cout << "--------------------------------------------------" << std::endl;
        std::cout << "[🏁 SYSTEM] Fenêtre de jeu fermée proprement par l'utilisateur." << std::endl;
    } else {
        std::cerr << "❌ Erreur : Impossible de créer le processus fils (fork)." << std::endl;
        return 1;
    }
    
    return 0;
}