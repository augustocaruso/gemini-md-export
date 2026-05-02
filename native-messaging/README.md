# Native Messaging

Este diretório contém o template do manifesto do host nativo usado pelos spikes
de transporte da extensão.

O Chrome exige dois valores específicos da instalação local:

- `path`: caminho absoluto para `gemini-md-export-native-host`;
- `allowed_origins`: ID real da extensão unpacked carregada no perfil do
  navegador.

Por isso este arquivo é template. Instaladores/repair scripts devem renderizar
o manifesto final no local esperado pelo navegador em vez de copiar o template
literalmente.
