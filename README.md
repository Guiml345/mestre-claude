# Mestre Claude

O Claude como mestre de RPG numa mesa do [Owlbear Rodeo](https://www.owlbear.rodeo): ele vê os tokens, move os bonecos, rola os dados e mostra avisos na tela, direto na mesa.

## Como funciona

```
Claude Code ──(MCP)──> servidor "mesa" ──(WebSocket em localhost:7420)──> extensão no Owlbear
                            │
                            └── dados, regras do D&D 5.5, contas de grade, registro de rolagens
```

- `server/`: servidor MCP em Node. Também é a "ponte": serve a extensão em `http://localhost:7420` e conversa com ela por WebSocket.
- `extension/`: extensão do Owlbear. Roda dentro da sala e executa o que o Claude pede usando o SDK oficial.
- `simulador/`: uma mesa de mentira para testar tudo sem entrar no Owlbear.

## Preparar (uma vez)

1. Instalar e compilar, na pasta do projeto:

   ```bash
   npm install
   ```

   ```bash
   npm run build
   ```

2. No Owlbear Rodeo, com a sua conta: abra o seu perfil, clique em **Add Extension** e cole o endereço abaixo. Depois ative a extensão "Mestre Claude" na sala.

   ```
   http://localhost:7420/manifest.json
   ```

   Se o Chrome perguntar se o Owlbear pode acessar apps neste dispositivo ou na rede local, permita: é a extensão falando com a ponte no seu computador.

3. Abra uma sessão nova do Claude Code nesta pasta e aprove o servidor MCP `mesa` quando ele perguntar. A ponte sobe junto com a sessão e a extensão se conecta sozinha em alguns segundos (o ícone dela ganha um selo "on").

## Usar

Fale com o Claude normalmente: "como está a mesa?", "move o goblin para o lado do Leo", "rola o ataque do goblin contra CA 18".

| Ferramenta | O que faz |
|---|---|
| `status_mesa` | Diz se a mesa está conectada, quem está na sala e como é a grade |
| `listar_tokens` | Lista os tokens com a casa (coluna, linha) de cada um e a área dos mapas |
| `mover_token` | Move para uma casa, por um deslocamento, ou para o lado de outro token |
| `editar_token` | Muda o rótulo ou esconde/revela um token |
| `rolar` | Rola dados, julga contra CD/CA pelas regras do D&D 5.5 e mostra na mesa |
| `anunciar` | Mostra um aviso curto na tela da mesa |
| `aguardar_jogadores` | Espera você digitar uma ação na caixa do painel da extensão, dentro do Owlbear |
| `ver_mapa` | Mostra ao Claude a imagem do mapa com a grade numerada e os tokens, para ele enxergar paredes e portas |
| `criar_token` / `remover_token` | Copia um token da cena (ex.: mais goblins) ou tira um token da cena |
| `iniciar_combate`, `proximo_turno`, `alterar_combatente`, `ver_combate`, `encerrar_combate` | Ordem de iniciativa, PV e condições, mostrados no painel da extensão |
| `nevoa` | Liga, desliga, cobre e revela a névoa de guerra |
| `focar_camera` | Leva a câmera de quem quiser até um ponto do mapa |
| `inventario` | Consulta e muda o inventário (aba Inventário do painel, que os jogadores editam direto) |

As fichas ficam na pasta `fichas/`: copie `fichas/MODELO.md` com o nome do personagem e preencha.

Toda rolagem fica gravada em `campanha/rolagens.jsonl`.

## Testar sem o Owlbear

Em um terminal, suba a ponte:

```bash
npm run mesa -- servir
```

Em outro, a mesa simulada, e abra `http://localhost:7421`:

```bash
npm run simulador
```

Com isso dá para mandar comandos pela linha de comando (`npm run mesa -- ajuda` lista todos):

```bash
npm run mesa -- tokens
```

Os testes automatizados rodam com:

```bash
npm test
```

## Limites desta versão

- Só o navegador do mestre se conecta ao Claude. Como a extensão é servida do seu computador, os outros jogadores veem os tokens se movendo (isso o Owlbear sincroniza), mas não recebem os avisos nem as rolagens na tela deles. Para isso a extensão precisa ser hospedada na internet.
- `mover_token` não enxerga paredes nem confere o deslocamento do personagem, e só trabalha com grade quadrada.
- O Claude ainda não enxerga a imagem do mapa, só as posições dos tokens.

## Configuração

| Variável | Para quê | Padrão |
|---|---|---|
| `MESA_RPG_PORT` | Porta da ponte | `7420` |
| `MESA_RPG_CAMPANHA` | Pasta do registro de rolagens | `campanha/` |
| `MESA_RPG_ORIGENS` | Origens extras (separadas por vírgula) que podem conectar como mesa | nenhuma |

O `.mcp.json` aponta para o caminho completo de `server/dist/index.js`. Se a pasta do projeto mudar de lugar, atualize esse caminho.

## Jogar com amigos (extensão publicada no GitHub Pages)

A extensão também fica publicada em `https://guiml345.github.io/<nome-do-repositório>/manifest.json`, montada automaticamente a cada envio para a branch `main`. É esse endereço que todos instalam no perfil do Owlbear, para quem não roda o Claude também conseguir abrir o painel.

- Só o computador do mestre roda o Claude Code e a ponte (porta 7420). O navegador dele se liga ao Claude; os outros jogadores mandam as ações pelo próprio Owlbear para esse navegador.
- Os outros jogadores não precisam instalar nada além do endereço do manifesto.
- O `.mcp.json` não vai para o repositório (tem o caminho da pasta no seu computador). Num computador novo, crie-o assim:

```json
{
  "mcpServers": {
    "mesa": { "command": "node", "args": ["<caminho da pasta>/server/dist/index.js"] }
  }
}
```
