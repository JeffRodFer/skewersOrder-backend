const express = require('express');
const cors = require('cors');
require('dotenv').config();
const pool = require('./db');
const bcrypt = require('bcrypt');
const crypto = require('crypto'); // <-- ADICIONE ESTA LINHA AQUI
const app = express();

// ==========================================
// 1. CONFIGURAÇÕES GERAIS
// ==========================================
// Permite comunicação do seu Front-end com o Back-end
app.use(cors());

// Permite o servidor entender JSON (O "óleo no motor")
app.use(express.json());

// ==========================================
// ROTA 1: BUSCAR CARDÁPIO (BLINDADA COM TENANT_ID)
// ==========================================
app.get('/api/cardapio', async (req, res) => {
  const tenantId = req.query.usuario;

  try {
    const query = `
      SELECT * FROM produtos 
      WHERE tenant_id = $1 
      ORDER BY categoria, id;
    `;
    const { rows } = await pool.query(query, [tenantId]);
    res.json({ produtos: rows });

  } catch (error) {
    console.error("Erro ao buscar cardápio:", error);
    res.status(500).json({ error: 'Erro ao buscar produtos' });
  }
});

// ==========================================
// ROTA 2: Salvar o pedido E os itens do carrinho (Com Transação)
// ==========================================
app.post('/api/pedidos', async (req, res) => {
  const { tenantId, clienteNome, total, tipoEntrega, carrinho } = req.body;

  const idDoNovoPedido = crypto.randomUUID();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const queryPedido = `
      INSERT INTO pedidos (id, tenant_id, cliente_nome, total, tipo_entrega) 
      VALUES ($1, $2, $3, $4, $5) RETURNING *;
    `;
    const valPedido = [idDoNovoPedido, tenantId, clienteNome, total, tipoEntrega];
    const resultadoPedido = await client.query(queryPedido, valPedido);

    const queryItem = `
      INSERT INTO itens_pedido 
      (pedido_id, produto_id, quantidade, preco_unitario) 
      VALUES ($1, $2, $3, $4)
    `;

    for (let item of carrinho) {
      const valItem = [idDoNovoPedido, item.id, item.quantidade, item.preco];
      await client.query(queryItem, valItem);

      // === PASSO 3: BAIXA NO ESTOQUE ===
      // Usa o nome correto da coluna revelado no Neon: 'estoque'
      const queryBaixa = `UPDATE produtos SET estoque = estoque - $1 WHERE id = $2`;
      await client.query(queryBaixa, [item.quantidade, item.id]);
    }

    await client.query('COMMIT');

    return res.status(201).json({
      mensagem: "Pedido e Itens salvos com sucesso!",
      id: idDoNovoPedido,
      pedido: resultadoPedido.rows[0]
    });

  } catch (erro) {
    await client.query('ROLLBACK');
    console.error("Erro na transação. Tudo desfeito:", erro);
    return res.status(500).json({ erro: "Falha ao gravar pedido completo" });

  } finally {
    client.release();
  }
});


// ==========================================
// 3. ROTAS DE ADMINISTRAÇÃO (Gerente)
// ==========================================

// Diagnóstico do login (Aparece apenas no terminal do VS Code)
console.log('Diagnóstico do login:', {
  adminUserConfigurado: Boolean(process.env.ADMIN_USER),
  adminPassConfigurada: Boolean(process.env.ADMIN_PASS)
});


// 2. ROTA (Note a palavra 'async' adicionada antes do req, res)
app.post('/admin/login', async (req, res) => {

  const { usuario, senha } = req.body;

  const userCerto = process.env.ADMIN_USER;
  const hashCerto = process.env.ADMIN_PASS_HASH;

  // ADICIONE ESTES DOIS CONSOLE.LOG AQUI:
  console.log("1. Senha que chegou do site:", senha);
  console.log("2. Hash lido do arquivo .env:", hashCerto);

  // Passo 1: Verifica o usuário. Se estiver errado, já barra aqui.
  if (usuario !== userCerto) {
    return res.status(401).json({
      erro: 'Usuário incorreto'
    });
  }

  // Passo 2: Verifica a senha usando o bcrypt
  try {
    //
    const senhaValida = await bcrypt.compare(senha, hashCerto);

    if (senhaValida === true) {
      return res.json({ mensagem: 'Acesso liberado!' });
    } else {
      return res.status(401).json({ erro: 'Senha incorreta' });
    }

  } catch (erro) {
    console.error('Erro na verificação do Hash:', erro);
    return res.status(500).json({ erro: 'Erro interno no servidor' });
  }
});

// ==========================================
// ROTA 3: RELATÓRIO DO GRÁFICO (TOP 7)
// ==========================================
app.get('/api/relatorios/top5/:tenantId', async (req, res) => {
  const { tenantId } = req.params;
  try {
    const query = `
      SELECT p.nome as nome, SUM(i.quantidade) as total_vendido
      FROM itens_pedido i
      JOIN produtos p ON i.produto_id = p.id
      WHERE p.tenant_id = $1
      GROUP BY p.nome
      ORDER BY total_vendido DESC
      LIMIT 7; -- AQUI ESTÁ A MUDANÇA (De 5 para 7)
    `;
    const { rows } = await pool.query(query, [tenantId]);
    res.json(rows);
  } catch (error) {
    console.error("Erro ao gerar relatório:", error);
    res.status(500).json({ error: 'Erro ao buscar dados do gráfico' });
  }
});

// ROTA 2: Atualizar disponibilidade
app.post('/admin/atualizar', async (req, res) => {
  const { usuario, senha, idProduto, disponivel } = req.body;

  // ADICIONE ESTA LINHA:
  console.log("O botão enviou:", usuario, senha);

  const userCerto = process.env.ADMIN_USER;
  const hashCerto = process.env.ADMIN_PASS_HASH;

  // 1. Verifica se o usuário está correto
  if (usuario !== userCerto) {
    return res.status(401).json({ erro: 'Usuário incorreto!' });
  }

  try {
    // 2. O bcrypt cruza a senha digitada com o Hash do .env
    const senhaValida = await bcrypt.compare(senha, hashCerto);

    // Se a senha não bater, bloqueia
    if (!senhaValida) {
      return res.status(401).json({ erro: 'Senha incorreta!' });
    }

    // 3. Acesso liberado! Altera o item no banco de dados
    const query = `
      UPDATE produtos 
      SET disponivel = $1 
      WHERE id = $2
    `;
    await pool.query(query, [disponivel, idProduto]);

    return res.json({ mensagem: 'Atualizado com sucesso!' });

  } catch (erro) {
    console.error('Erro na atualização:', erro);
    return res.status(500).json({ erro: 'Erro ao atualizar item' });
  }
});

// ROTA: Salvar alterações em lote (Status + Estoque)
app.post('/admin/atualizar-lote', async (req, res) => {
  const {
    usuario,
    senha,
    produtos,
    listaProdutos
  } = req.body;

  // Aceita tanto 'produtos' quanto 'listaProdutos'
  const listaFinal = produtos || listaProdutos;

  const userCerto = process.env.ADMIN_USER;
  const hashCerto = process.env.ADMIN_PASS_HASH;

  if (usuario !== userCerto) {
    return res.status(401).json({ erro: 'Usuário incorreto!' });
  }

  if (!Array.isArray(listaFinal)) {
    return res.status(400).json({
      erro: 'Lista de produtos não enviada.'
    });
  }

  try {
    const senhaValida = await bcrypt.compare(senha, hashCerto);
    if (!senhaValida) {
      return res.status(401).json({ erro: 'Senha incorreta!' });
    }

    for (let item of listaFinal) {
      const query = `
        UPDATE produtos
        SET disponivel = $1,
            estoque = COALESCE($2, estoque)
        WHERE id = $3
      `;
      await pool.query(query, [
        item.disponivel,
        item.estoque,
        item.id
      ]);
    }

    return res.json({ mensagem: 'Cardápio salvo com sucesso!' });

  } catch (erro) {
    console.error('Erro ao salvar lote:', erro);
    return res.status(500).json({ erro: 'Erro ao salvar' });
  }
});

// ROTA: Salvar alterações em lote (Status + Estoque)
app.post('/admin/atualizar-lote', async (req, res) => {
  const { usuario, senha, listaProdutos } = req.body;

  const userCerto = process.env.ADMIN_USER;
  const hashCerto = process.env.ADMIN_PASS_HASH;

  if (usuario !== userCerto) {
    return res.status(401).json({ erro: 'Usuário incorreto!' });
  }

  try {
    const senhaValida = await bcrypt.compare(senha, hashCerto);
    if (!senhaValida) {
      return res.status(401).json({ erro: 'Senha incorreta!' });
    }

    for (let item of listaProdutos) {
      const query = `
        UPDATE produtos
        SET disponivel = $1,
            estoque = COALESCE($2, estoque)
        WHERE id = $3
      `;
      await pool.query(query, [
        item.disponivel,
        item.estoque,
        item.id
      ]);
    }

    return res.json({ mensagem: 'Cardápio salvo com sucesso!' });

  } catch (erro) {
    console.error('Erro ao salvar lote:', erro);
    return res.status(500).json({ erro: 'Erro ao salvar' });
  }
});

// ROTA: Estornar (Devolver unidades ao estoque)
app.post('/admin/estornar', async (req, res) => {
  const { usuario, senha, itensEstorno } = req.body;

  const userCerto = process.env.ADMIN_USER;
  const hashCerto = process.env.ADMIN_PASS_HASH;

  if (usuario !== userCerto) {
    return res.status(401).json({ erro: 'Usuário incorreto!' });
  }

  if (!Array.isArray(itensEstorno)) {
    return res.status(400).json({
      erro: 'Nenhum item enviado para estorno.'
    });
  }

  try {
    const senhaValida = await bcrypt.compare(senha, hashCerto);
    if (!senhaValida) {
      return res.status(401).json({ erro: 'Senha incorreta!' });
    }

    for (let item of itensEstorno) {
      const qtd = Number(item.quantidade) || 0;
      const query = `
        UPDATE produtos
        SET estoque = COALESCE(estoque, 0) + $1
        WHERE id = $2
      `;
      await pool.query(query, [qtd, item.id]);
    }

    return res.json({
      mensagem: 'Estoque estornado com sucesso!'
    });
  } catch (erro) {
    console.error('Erro ao estornar:', erro);
    return res.status(500).json({ erro: 'Erro ao estornar' });
  }
});

// ROTA 2: Salvar pedido + Baixa automática de estoque
app.post('/api/pedidos', async (req, res) => {
  const {
    tenantId,
    clienteNome,
    total,
    tipoEntrega,
    carrinho
  } = req.body;

  const idDoNovoPedido = crypto.randomUUID();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const queryPedido = `
      INSERT INTO pedidos
      (id, usuario_id, cliente_nome, total, tipo_entrega)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *;
    `;
    const valPedido = [
      idDoNovoPedido,
      tenantId,
      clienteNome,
      total,
      tipoEntrega
    ];
    await client.query(queryPedido, valPedido);

    const queryItem = `
      INSERT INTO itens_pedido
      (pedido_id, produto_id, quantidade, preco_unitario)
      VALUES ($1, $2, $3, $4)
    `;

    const queryBaixa = `
      UPDATE produtos
      SET estoque = GREATEST(estoque - $1, 0)
      WHERE id = $2
    `;

    for (let item of carrinho) {
      const valItem = [
        idDoNovoPedido,
        item.id,
        item.quantidade,
        item.preco
      ];
      await client.query(queryItem, valItem);
      await client.query(queryBaixa, [item.quantidade, item.id]);
    }

    await client.query('COMMIT');
    return res.status(201).json({
      mensagem: 'Pedido salvo com sucesso!',
      id: idDoNovoPedido
    });
  } catch (erro) {
    await client.query('ROLLBACK');
    console.error('Erro ao gravar pedido:', erro);
    return res.status(500).json({ erro: 'Falha ao gravar' });
  } finally {
    client.release();
  }
});


// ==========================================
// 4. LIGANDO O SERVIDOR
// ==========================================
const PORTA = process.env.PORT || 3000;

app.listen(PORTA, () => {
  console.log(`✅ Servidor rodando lindamente na porta ${PORTA}`);
});

// ==========================================
// ROTA 4: RELATÓRIO DE VENDAS DIÁRIAS
// ==========================================
app.get('/api/relatorios/vendas-diarias/:tenantId', async (req, res) => {
  const { tenantId } = req.params;
  try {
    // ATENÇÃO: Verifique qual é o nome da coluna de data na sua tabela 'pedidos'. 
    // Pode ser 'data_pedido', 'criado_em' ou 'created_at'. Altere abaixo se necessário.
    const query = `
      SELECT DATE(data_pedido) as data_venda, SUM(total) as total_arrecadado
      FROM pedidos
      WHERE tenant_id = $1
      GROUP BY DATE(data_pedido)
      ORDER BY data_venda DESC;
    `;
    const { rows } = await pool.query(query, [tenantId]);
    res.json(rows);
  } catch (error) {
    console.error("Erro ao buscar vendas diárias:", error);
    res.status(500).json({ error: 'Erro ao buscar vendas' });
  }
});


// ==========================================
// ROTA 5: RATEIO POR DATA (DIA OPERACIONAL)
// ==========================================
app.get('/api/relatorios/dia/:tenantId', async (req, res) => {
  const { tenantId } = req.params;
  const { data } = req.query;

  if (!data) {
    return res.status(400).json({ erro: 'Informe a data' });
  }

  try {
    const query = `
      SELECT
        COUNT(*) AS total_pedidos,
        COALESCE(SUM(total), 0) AS faturamento,
        tipo_entrega
      FROM pedidos
      WHERE tenant_id = $1
        AND DATE(
          (data_pedido AT TIME ZONE 'America/Recife')
          - INTERVAL '3 hours'
        ) = $2
      GROUP BY tipo_entrega
    `;
    const { rows } = await pool.query(query, [tenantId, data]);
    return res.json(rows);
  } catch (erro) {
    console.error('Erro ao buscar por data:', erro);
    return res.status(500).json({ erro: 'Erro no banco' });
  }
});

// ==========================================
// ROTA 6: RELATÓRIO POR PERÍODO (DE / ATÉ)
// ==========================================
app.get('/api/relatorios/periodo/:tenantId', async (req, res) => {
  const { tenantId } = req.params;
  const { inicio, fim } = req.query;

  if (!inicio || !fim) {
    return res.status(400).json({ erro: 'Informe as datas' });
  }

  try {
    const query = `
      SELECT
        COUNT(*) AS total_pedidos,
        COALESCE(SUM(total), 0) AS faturamento,
        tipo_entrega
      FROM pedidos
      WHERE tenant_id = $1
        AND DATE(
          (data_pedido AT TIME ZONE 'America/Recife')
          - INTERVAL '3 hours'
        ) BETWEEN $2 AND $3
      GROUP BY tipo_entrega
    `;
    const params = [tenantId, inicio, fim];
    const { rows } = await pool.query(query, params);
    return res.json(rows);
  } catch (erro) {
    console.error('Erro ao buscar período:', erro);
    return res.status(500).json({ erro: 'Erro no banco' });
  }
});

// ==========================================
// ROTA 7: LISTA TODOS OS PEDIDOS DO PERÍODO
// ==========================================
app.get('/api/relatorios/pedidos/:tenantId', async (req, res) => {
  const { tenantId } = req.params;
  const { inicio, fim } = req.query;

  if (!inicio || !fim) {
    return res.status(400).json({ erro: 'Informe inicio e fim' });
  }

  try {
    const sql = `
      SELECT
        cliente_nome,
        total,
        tipo_entrega,
        farofa,
        vinagrete,
        observacoes,
        data_pedido AT TIME ZONE 'America/Recife' AS hora_local
      FROM pedidos
      WHERE tenant_id = $1
        AND DATE(
          (data_pedido AT TIME ZONE 'America/Recife')
          - INTERVAL '3 hours'
        ) BETWEEN $2 AND $3
      ORDER BY data_pedido DESC
    `;

    const { rows } = await pool.query(sql, [
      tenantId,
      inicio,
      fim
    ]);
    return res.json(rows);
  } catch (erro) {
    console.error('Erro ao listar pedidos:', erro);
    return res.status(500).json({ erro: 'Erro no banco' });
  }
});



