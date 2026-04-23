//backend/routes/skills.js
const express = require('express');
const router = express.Router();
const Skill = require('../models/Skill');
const Joi = require('joi');
const verifyJWT = require('../middleware/authMiddleware');

const createSkillSchema = Joi.object({
  name: Joi.string().min(1).max(100).required(),
});

// GET /api/skills (public) – for dropdowns/autocomplete
router.get('/', async (req, res) => {
  try {
    const skills = await Skill.find({}).sort({ name: 1 });
    res.json(skills);
  } catch (err) {
    res.status(500).json({ message: 'Error loading skills', error: err.message });
  }
});

// POST /api/skills (authenticated; you can restrict to students if you want)
router.post('/', verifyJWT, async (req, res) => {
  try {
    const { error, value } = createSkillSchema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });
    if (error) {
      return res.status(400).json({
        message: 'Validation error',
        details: error.details.map((d) => d.message),
      });
    }

    const name = value.name.trim();
    let skill = await Skill.findOne({ name: new RegExp(`^${name}$`, 'i') });
    if (!skill) {
      skill = await Skill.create({ name });
    }
    res.status(201).json(skill);
  } catch (err) {
    res.status(500).json({ message: 'Error creating skill', error: err.message });
  }
});

module.exports = router;