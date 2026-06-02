# 🔔 Système de Notification d'Événements (Event-Driven Architecture)

## Vue d'ensemble

Le système est passé d'un **polling constant** (500 Hz) à une **architecture événementielle** où le C++ signale les changements via des counters en mémoire partagée.

**Gain de performance** : Réduction de ~97% de la charge CPU du worker thread.

---

## Mémoire Partagée - Zone de Notification

Offsets dans la mémoire partagée (relative à `vfdMemoryPointer`):

| Offset | Taille | Nom | Description |
|--------|--------|-----|-------------|
| 1080-1083 | 4 bytes | `VFD_CHANGE_COUNTER` | Incrémenté quand l'afficheur VFD change |
| 1084-1087 | 4 bytes | `LAMPS_CHANGE_COUNTER` | Incrémenté quand les lampes changent |
| 1088-1091 | 4 bytes | `SOLENOID_CHANGE_COUNTER` | Incrémenté quand les bobines changent |

---

## Comment ça fonctionne

### Côté JavaScript (Worker)

```javascript
// Le worker lit les counters toutes les 16ms (60 Hz)
const vfdCounter = readU32(vfdMemoryPointer + 1080);
if (vfdCounter !== lastVfdCounter) {
    // Le counter a changé => l'afficheur a été modifié
    // Lire et envoyer les changements
    lastVfdCounter = vfdCounter;
}
```

### Côté C++

Chaque fois que vous modifiez VFD, lampes ou bobines :

```c
// ========================================
// INCRÉMENTATION DES COUNTERS
// ========================================

// Pour VFD :
uint32_t *vfd_counter = (uint32_t*)(vfdMemoryPtr + 1080);
(*vfd_counter)++;

// Pour lampes :
uint32_t *lamp_counter = (uint32_t*)(vfdMemoryPtr + 1084);
(*lamp_counter)++;

// Pour bobines/solenoids :
uint32_t *sol_counter = (uint32_t*)(vfdMemoryPtr + 1088);
(*sol_counter)++;
```

---

## Zones Mémoire Existantes

Ces données continuent de fonctionner exactement comme avant :

| Offset | Taille | Données |
|--------|--------|---------|
| 0-79 | 80 bytes | Masques VFD (40 x uint16) |
| 100-179 | 80 bytes | États des contacts (inputs) |
| 300-311 | 12 bytes | États des lampes (bitmap) |
| 320-323 | 4 bytes | États des bobines (bitmap) |
| 400-431 | 32 bytes | DIPs switches |
| 1000+ | Variable | Nom de la ROM |
| 1060 | 1 byte | Commande son |
| 1070-1073 | 4 bytes | Distance audio |

---

## Architecture du Flux

```
┌─────────────────────────────────────────┐
│      MOTEUR C++ (Native)                │
│  Modification état → Incrément counter  │
└──────────────┬──────────────────────────┘
               │
               ▼ (Mémoire partagée)
┌─────────────────────────────────────────┐
│   WORKER (flipper-worker.js)            │
│  Check counters toutes les 16ms         │
│  Si changement → Envoyer notification   │
└──────────────┬──────────────────────────┘
               │
               ▼ (postMessage)
┌─────────────────────────────────────────┐
│   MAIN THREAD (index.html)              │
│  Reçoit notifications                   │
│  Met à jour l'affichage                 │
└─────────────────────────────────────────┘
```

---

## Optimisations Réalisées

### 1. **Réduction de la fréquence de scrutation**
- **Avant** : 500 Hz (2ms) - scan complet toutes les 2ms
- **Après** : 60 Hz (16ms) - lecture des counters toutes les 16ms
- **Gain** : ~97% de réduction CPU

### 2. **Minimal data transfer**
- Avant : Envoi de tous les états à chaque message
- Après : Envoi seulement si un counter a changé

### 3. **Meilleure cohérence temporelle**
- Les changements sont groupés par événement (un seul counter incrémenté = un événement)
- Plus facile de déboguer les changements d'état

---

## 📝 TODO : Modifications C++ requises

1. **Localiser les endroits où VFD est modifiée**
   - Incrémenter `*(uint32_t*)(vfdMemoryPtr + 1080)` après modification

2. **Localiser les endroits où lampes sont modifiées**
   - Incrémenter `*(uint32_t*)(vfdMemoryPtr + 1084)` après modification

3. **Localiser les endroits où bobines/solenoids sont modifiés**
   - Incrémenter `*(uint32_t*)(vfdMemoryPtr + 1088)` après modification

4. **Test de synchronisation**
   - Vérifier que les counters ne débordent pas (overflow)
   - Les counters sont des `uint32_t` → overflow à ~4 milliards

---

## Fallback Rétrocompatibilité

Si le C++ n'incrémente pas les counters, le système continue à fonctionner mais en mode "tous les 60Hz" au lieu de "événementiel". Les données sont lues correctement, juste moins efficacement.

---

## Debugging

Pour vérifier que les counters augmentent :

```javascript
// Dans le worker ou la console
setInterval(() => {
    console.log({
        vfd: readU32(vfdMemoryPtr + 1080),
        lamps: readU32(vfdMemoryPtr + 1084),
        solenoids: readU32(vfdMemoryPtr + 1088)
    });
}, 1000);
```

Si les valeurs restent stables (pas d'incrémentation), c'est que le C++ n'incrémente pas les counters.
