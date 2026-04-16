const College = require('../models/College');

// 🚀 ULTRA-FAST CACHE (Acts like Redis but in Node RAM) 🚀
const predictionCache = new Map();
const dropdownCache = new Map();

// Clears cache every 10 minutes to keep data fresh but server load low
setInterval(() => {
    predictionCache.clear();
    dropdownCache.clear();
    console.log("🧹 Prediction & Dropdown Cache auto-cleared.");
}, 10 * 60 * 1000); 

exports.getPredictions = async (req, res) => {
    try {
        const { exam, rank, category, course, dream, state, district } = req.body;
        const userValue = parseFloat(rank);
        const examMode = exam || 'NEET'; 
        
        // 🌟 CHECK CACHE FIRST (0ms Response for repeated queries) 🌟
        const cacheKey = `${examMode}-${userValue}-${category}-${course}-${dream}-${state}-${district}`;
        if (predictionCache.has(cacheKey)) {
            return res.status(200).json(predictionCache.get(cacheKey));
        }

        let strictQuery = { exam: examMode };
        
        if (examMode === '12th') {
            strictQuery[`cutoffs.${category}`] = { $lte: userValue, $gt: 0 };
        } else {
            strictQuery[`cutoffs.${category}`] = { $gte: userValue, $gt: 0 }; 
        }
        
        if (state && state !== 'All India (Any State)') {
            strictQuery.state = { $regex: new RegExp(`^${state}$`, 'i') }; // Exact match is faster
        }

        let andConditions = [];

        if (course && course !== 'All') {
            if (course === 'AIIMS') andConditions.push({ name: { $regex: 'AIIMS', $options: 'i' } });
            else strictQuery.course = { $regex: new RegExp(`^${course}$`, 'i') };
        }

        if (dream && dream !== 'All Colleges') {
            andConditions.push({ name: dream }); 
        } else {
            if (district && district !== 'All Districts') {
                andConditions.push({ name: { $regex: district, $options: 'i' } });
            }
        }

        if (andConditions.length > 0) strictQuery.$and = andConditions;

        let isFallback = false;
        // 🚀 .lean() makes Mongoose 5x faster by returning plain JSON objects 🚀
        let colleges = await College.find(strictQuery).lean().limit(30);

        // 🌟 FALLBACK ENGINE
        if (colleges.length === 0) {
            isFallback = true; 
            let fallbackQuery = { exam: examMode };
            
            if (examMode === '12th') fallbackQuery[`cutoffs.${category}`] = { $lte: userValue, $gt: 0 };
            else fallbackQuery[`cutoffs.${category}`] = { $gte: userValue, $gt: 0 };
            
            if (state && state !== 'All India (Any State)') {
                fallbackQuery.state = { $regex: new RegExp(`^${state}$`, 'i') };
            }

            if (course && course !== 'All') {
                if (course === 'AIIMS') fallbackQuery.name = { $regex: 'AIIMS', $options: 'i' };
                else fallbackQuery.course = { $regex: new RegExp(`^${course}$`, 'i') };
            }
            colleges = await College.find(fallbackQuery).lean().limit(30);

            if (colleges.length === 0) {
                let pureFallback = { exam: examMode };
                if (examMode === '12th') pureFallback[`cutoffs.${category}`] = { $lte: userValue, $gt: 0 };
                else pureFallback[`cutoffs.${category}`] = { $gte: userValue, $gt: 0 };
                
                if (state && state !== 'All India (Any State)') {
                    pureFallback.state = { $regex: new RegExp(`^${state}$`, 'i') };
                }

                colleges = await College.find(pureFallback).lean().limit(30);
            }
        }

        if (colleges.length === 0) {
            const nullResponse = { success: true, colleges: [], isFallback: false };
            predictionCache.set(cacheKey, nullResponse);
            return res.status(200).json(nullResponse); 
        }

        let matchedColleges = colleges.map(college => {
            const cutoff = college.cutoffs[category]; 
            let probability = "Borderline 🟡";

            // 🌟 SMART PROBABILITY CALCULATION
            if (examMode === '12th') {
                if ((userValue - cutoff) >= 2) probability = "Safe Zone 🟢";
            } else {
                if ((cutoff - userValue) > (cutoff * 0.05)) probability = "Safe Zone 🟢";
            }

            return {
                id: college._id,
                name: college.name,
                state: college.state || "India",
                course: college.course,
                category: category,
                currentCutoff: cutoff,
                probability: probability,
                tags: [college.course, category]
            };
        });

        // 🌟 DYNAMIC SORTING
        if (examMode === '12th') {
            matchedColleges.sort((a, b) => b.currentCutoff - a.currentCutoff);
        } else {
            matchedColleges.sort((a, b) => a.currentCutoff - b.currentCutoff);
        }

        const finalResponse = { success: true, isFallback: isFallback, totalFound: matchedColleges.length, colleges: matchedColleges };
        
        // Save to cache before sending
        predictionCache.set(cacheKey, finalResponse);
        res.status(200).json(finalResponse);

    } catch (error) {
        console.error("Prediction Error:", error);
        res.status(500).json({ success: false, message: "Server Error." });
    }
};

exports.getDropdownOptions = async (req, res) => {
    try {
        const { course, state, district, exam } = req.body;
        
        // 🌟 CHECK CACHE FIRST 🌟
        const cacheKey = `${exam || 'NEET'}-${course}-${state}-${district}`;
        if (dropdownCache.has(cacheKey)) {
            return res.status(200).json(dropdownCache.get(cacheKey));
        }

        let query = { exam: exam || 'NEET' }; 
        let andConditions = [];

        if (state && state !== 'All India (Any State)') {
            query.state = { $regex: new RegExp(`^${state}$`, 'i') };
        }

        if (course && course !== 'All') {
            if (course === 'AIIMS') andConditions.push({ name: { $regex: 'AIIMS', $options: 'i' } });
            else query.course = { $regex: new RegExp(`^${course}$`, 'i') };
        }

        if (district && district !== 'All Districts') {
            andConditions.push({ name: { $regex: district, $options: 'i' } });
        }

        if (andConditions.length > 0) query.$and = andConditions;

        // .select() + .lean() = Lightning fast queries
        const colleges = await College.find(query).select('name -_id').lean().limit(1500);
        const names = [...new Set(colleges.map(c => c.name))].sort();

        const response = { success: true, names };
        dropdownCache.set(cacheKey, response); // Cache it
        
        res.status(200).json(response);
    } catch (error) {
        console.error("Dropdown Fetch Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
};